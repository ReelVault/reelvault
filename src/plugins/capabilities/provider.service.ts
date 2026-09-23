import type {
	MediaIdentity,
	MetadataProviderConfiguration,
	MetadataProviderSearchRequest,
	MetadataProviderSearchResponse,
	MetadataProviderStatus,
} from "@reelvault/sdk/common";
import type {
	ExternalIdentifiers,
	MetadataProvider,
	ProviderDiscoveryRequest,
	ProviderDiscoveryResult,
	ProviderEpisodeResult,
	ProviderImageResult,
	ProviderMediaType,
	ProviderMetadataResult,
	ProviderPersonResult,
	ProviderResultGenre,
	ProviderSearchRequest,
	ProviderSearchResponse,
	ProviderSeasonResult,
} from "@reelvault/sdk/plugin";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { serverConfig } from "@/server.config";
import { hasEntry, isNotNullish } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { errorMessage, ValidationError } from "@/utils/errors";
import { CONFIDENT_MATCH_SCORE, MIN_MATCH_SCORE, MIN_SCORE_MARGIN, rankCandidates, type ScoredCandidate } from "@/utils/media-match.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { normalizeLower } from "@/utils/type.utils";
import { type AggregatedMetadata, mergeProviderMetadata, type ProviderContribution } from "./metadata-aggregator";
import { metadataProviderSettingsService } from "./metadata-provider-settings.service";
import { ProviderResultCaches } from "./provider/inflight-cache";
import {
	discoveryCacheKey,
	isExternalIdentifierAwareProvider,
	matchesExternalIdentifiers,
	normalizeMetadataDetails,
	trimNameAndOverview,
} from "./provider/match-ranking";
import { type SearchCandidate, searchWithVariants } from "./provider/query-variants";

export interface ProviderDetails {
	provider: string;
	metadata: ProviderMetadataResult;
	matchScore?: number | undefined;
}

export interface ProviderSeasonDetails {
	provider: string;
	metadata: ProviderSeasonResult;
}

export interface ProviderEpisodeDetails {
	provider: string;
	metadata: ProviderEpisodeResult;
}

export interface ProviderPersonDetails {
	provider: string;
	metadata: ProviderPersonResult;
}
interface AcceptedMatch {
	provider: MetadataProvider;
	index: number;
	bestMatch: ScoredCandidate<SearchCandidate>;
}
/** A metadata provider plus that provider's own id for the entity (not the title's primary id). */
interface ProviderLink {
	providerId: string;
	externalId: string;
}

/** Thrown inside getOrSet loaders to signal "no match" without caching the null result. */
class NoMatchError extends Error {
	constructor() {
		super("No metadata provider match found");
		this.name = "NoMatchError";
	}
}

class ProviderService extends BaseService {
	private readonly caches = new ProviderResultCaches();

	constructor() {
		super("ProviderService");
	}

	/**
	 * Derived from the ordered providers on every call so priority/enabled changes
	 * invalidate provider-scoped caches. The registry generation is appended so a
	 * reload/upgrade of a provider with the same id cannot serve stale results
	 * under the previous implementation's key.
	 */
	private async getProviderKey(): Promise<string> {
		const providers = await metadataProviderSettingsService.getOrderedProviders();

		return `${providers.map((provider) => provider.id).join(",")}#${pluginRegistry.getGeneration()}`;
	}

	async search(request: MetadataProviderSearchRequest): Promise<MetadataProviderSearchResponse[]> {
		const { type, title, year } = request;
		const providerId = request.providerId?.trim();
		const externalId = request.externalId?.trim();
		if (providerId || externalId) {
			if (!(providerId && externalId)) throw new ValidationError("Searching by id requires both providerId and externalId");

			return await this.searchByProviderExternalId(type, providerId, externalId);
		}

		const query = title?.trim();
		if (!query) throw new ValidationError("Provide a title or a providerId + externalId pair to search");

		const grouped = await this.searchProviders({ type, query, year });

		return grouped.map((group) => ({
			providerId: group.providerId,
			results: group.results.map((item) => ({
				externalId: item.externalId,
				title: item.title,
				releaseDate: item.releaseDate,
				...(item.posterPath ? { posterPath: item.posterPath } : {}),
			})),
		}));
	}

	/**
	 * Title search across enabled providers (or a single `providerId`), with the
	 * provider's richer search result retained for callers that need artwork and
	 * popularity. Shared by the HTTP search endpoint and the plugin capability.
	 */
	async searchProviders(request: ProviderSearchRequest): Promise<ProviderSearchResponse[]> {
		const query = request.query.trim();
		if (!query) return [];

		this.publishSearchRequested(request.type, query, request.year);
		const allProviders = await metadataProviderSettingsService.getOrderedProviders();
		const providers = request.providerId ? allProviders.filter((provider) => provider.id === request.providerId) : allProviders;

		const results = await PromiseUtils.mapConcurrent(
			providers,
			serverConfig.plugins.providers.concurrency,
			async (provider): Promise<ProviderSearchResponse | null> => {
				try {
					const providerResults = await searchWithVariants(
						(searchQuery) => provider.search(request.type, searchQuery, request.year),
						query,
						request.year,
					);
					if (providerResults.length === 0) return null;

					const ranked = rankCandidates(providerResults, query, request.year).map((candidate) => candidate.item);

					return { providerId: provider.id, results: ranked };
				} catch (error) {
					this.logger.error(`Provider ${provider.id} failed`, error);

					return null;
				}
			},
		);

		return results.filter((result) => isNotNullish(result));
	}

	/**
	 * Exact lookup of an id in one provider's own namespace — works with every
	 * plugin, since `getDetails` is a required provider method. The id is passed
	 * through verbatim: no provider names or id formats are known to the server.
	 */
	private async searchByProviderExternalId(
		type: ProviderMediaType,
		providerId: string,
		externalId: string,
	): Promise<MetadataProviderSearchResponse[]> {
		const enabled = await metadataProviderSettingsService.getOrderedProviders();
		const enabledIds = new Set(enabled.map((p) => p.id));
		if (!enabledIds.has(providerId)) {
			throw new ValidationError(`Provider ${providerId} is not registered or is disabled`);
		}

		const metadata = await this.fetchDetailsByProvider(providerId, type, externalId);
		if (!metadata) return [];

		return [
			{
				providerId,
				results: [
					{
						externalId: metadata.externalId,
						title: metadata.title,
						releaseDate: metadata.releaseDate,
						...(metadata.posterPath ? { posterPath: metadata.posterPath } : {}),
					},
				],
			},
		];
	}

	/** Deduplicates concurrent detail lookups for the same title/year so a burst of requests only hits providers once. */
	async fetchDetails(type: "movie" | "tv_show", parsed: MediaIdentity): Promise<ProviderDetails[]> {
		const providerKey = await this.getProviderKey();
		const key = `${providerKey}:${type}:${normalizeLower(parsed.title)}:${parsed.year ?? ""}`;

		return await this.caches.details.getOrSet(key, () => this.fetchDetailsOnce(type, parsed));
	}

	/**
	 * Searches every enabled provider, then fetches and merges details from all
	 * that produced an acceptable match. The result follows provider priority:
	 * the highest-priority provider anchors each field, lower-priority providers
	 * fill gaps, and ratings are collected from every source.
	 */
	async fetchAggregatedDetails(type: "movie" | "tv_show", parsed: MediaIdentity): Promise<AggregatedMetadata | null> {
		const providerKey = await this.getProviderKey();
		const key = `${providerKey}:${type}:${normalizeLower(parsed.title)}:${parsed.year ?? ""}`;

		try {
			return await this.caches.aggregatedDetails.getOrSet(key, async () => {
				this.publishSearchRequested(type, parsed.title, parsed.year);
				const accepted = await this.collectAcceptedMatches(type, parsed);
				if (accepted.length === 0) throw new NoMatchError();

				const contributions = await PromiseUtils.mapConcurrent(
					accepted,
					serverConfig.plugins.providers.concurrency,
					async (candidate): Promise<ProviderContribution | null> => {
						try {
							const metadata = await candidate.provider.getDetails(type, candidate.bestMatch.item.externalId);
							if (!metadata) return null;

							return {
								providerId: candidate.provider.id,
								externalId: metadata.externalId,
								matchScore: Math.min(1, Number(candidate.bestMatch.score.toFixed(3))),
								metadata: normalizeMetadataDetails(metadata),
							};
						} catch (error) {
							this.logger.warn("Metadata provider details fetch failed during aggregation", {
								providerId: candidate.provider.id,
								priorityIndex: candidate.index,
								error: errorMessage(error),
							});

							return null;
						}
					},
				);

				const ordered = contributions.filter((contribution) => isNotNullish(contribution));
				if (ordered.length === 0) throw new NoMatchError();

				return mergeProviderMetadata(ordered);
			});
		} catch (error) {
			if (error instanceof NoMatchError) return null;

			throw error;
		}
	}

	/**
	 * Fetch a known provider entity without doing a title search first.
	 *
	 * This is used when refreshing already imported metadata: the persisted
	 * provider/external-ID pair is authoritative, while a new text search could
	 * silently select a different title.
	 */
	async fetchDetailsByProvider(
		providerId: string,
		type: "movie" | "tv_show",
		externalId: string,
	): Promise<ProviderMetadataResult | undefined> {
		const provider = pluginRegistry.getProvider(providerId);
		if (!provider) return undefined;

		try {
			const metadata = await provider.getDetails(type, externalId);

			return metadata ? normalizeMetadataDetails(metadata) : undefined;
		} catch (error) {
			this.logger.error(`Provider ${provider.id} failed`, error);

			return undefined;
		}
	}

	/** Resolves a title to the best matching provider's full metadata (no aggregation). */
	async resolveDetails(type: ProviderMediaType, title: string, year?: number): Promise<ProviderMetadataResult | null> {
		const details = await this.fetchDetails(type, { title, type, year });

		return details[0]?.metadata ?? null;
	}

	/**
	 * Curated discovery feed (trending/popular/upcoming/…). Resolves through the
	 * enabled providers in priority order and returns the first provider that
	 * supports the category and yields items. Positive results are cached; a
	 * miss is retried on the next call so a temporarily down provider recovers.
	 */
	async discover(request: ProviderDiscoveryRequest): Promise<ProviderDiscoveryResult | null> {
		const cacheKey = discoveryCacheKey(request);
		const cached = this.caches.discovery.get(cacheKey);
		if (cached) return cached;

		const allProviders = await metadataProviderSettingsService.getOrderedProviders();
		const providers = request.providerId ? allProviders.filter((provider) => provider.id === request.providerId) : allProviders;

		for (const provider of providers) {
			if (typeof provider.discover !== "function") continue;

			try {
				const page = await provider.discover(request);
				if (page.items.length > 0) {
					const result: ProviderDiscoveryResult = { providerId: provider.id, ...page };
					this.caches.discovery.set(cacheKey, result);

					return result;
				}
			} catch (error) {
				this.logger.warn("Metadata provider discovery failed, trying next provider", {
					providerId: provider.id,
					category: request.category,
					error: errorMessage(error),
				});
			}
		}

		return null;
	}

	/** Genre catalogue from the first enabled provider that exposes it. */
	async getGenres(type: ProviderMediaType, providerId?: string): Promise<ProviderResultGenre[]> {
		const cacheKey = `genres:${providerId ?? "*"}:${type}`;
		const cached = this.caches.genres.get(cacheKey);
		if (cached) return cached;

		const allProviders = await metadataProviderSettingsService.getOrderedProviders();
		const providers = providerId ? allProviders.filter((provider) => provider.id === providerId) : allProviders;

		for (const provider of providers) {
			if (typeof provider.getGenres !== "function") continue;

			try {
				const genres = await provider.getGenres(type);
				if (genres.length > 0) {
					this.caches.genres.set(cacheKey, genres);

					return genres;
				}
			} catch (error) {
				this.logger.warn("Metadata provider genre lookup failed, trying next provider", {
					providerId: provider.id,
					type,
					error: errorMessage(error),
				});
			}
		}

		return [];
	}

	async fetchDetailsByLocalIdentifiers(type: ProviderMediaType, identifiers: ExternalIdentifiers): Promise<ProviderDetails[]> {
		if (!hasEntry(identifiers)) return [];

		const providers = (await metadataProviderSettingsService.getOrderedProviders()).filter((candidate) =>
			isExternalIdentifierAwareProvider(candidate),
		);
		const allIdentifierValues = Object.values(identifiers);
		const identifierSet = new Set(allIdentifierValues);

		// Query every identifier-aware provider in parallel (bounded by configured
		// concurrency), then pick the first hit in the original priority order —
		// the network lookups no longer block on each other, but provider
		// priority still decides the winner.
		const results = await PromiseUtils.mapConcurrent(providers, serverConfig.plugins.providers.concurrency, async (provider) => {
			try {
				const metadata = await provider.getDetailsByExternalIds(type, identifiers);
				if (!(metadata && matchesExternalIdentifiers(provider.id, metadata, identifiers, identifierSet))) return null;

				return { provider: provider.id, metadata: normalizeMetadataDetails(metadata) } satisfies ProviderDetails;
			} catch (error) {
				this.logger.warn("Metadata provider identifier lookup failed", {
					providerId: provider.id,
					error: errorMessage(error),
				});

				return null;
			}
		});

		const firstMatch = results.find((result) => isNotNullish(result));

		return firstMatch ? [firstMatch] : [];
	}

	/** Fetches selectable artwork from one provider without changing persisted metadata. */
	async fetchImagesByProvider(providerId: string, type: "movie" | "tv_show", externalId: string): Promise<ProviderImageResult[]> {
		const provider = pluginRegistry.getProvider(providerId);
		if (!provider?.getImages) return [];

		try {
			return (await provider.getImages(type, externalId)).filter((image) => Boolean(image.url));
		} catch (error) {
			this.logger.error(`Provider ${providerId} image lookup failed`, error);

			return [];
		}
	}

	/**
	 * Searches every enabled provider in parallel (bounded by configured
	 * concurrency) and returns the confident matches sorted by provider priority.
	 */
	private async collectAcceptedMatches(type: "movie" | "tv_show", parsed: MediaIdentity): Promise<AcceptedMatch[]> {
		const providers = await metadataProviderSettingsService.getOrderedProviders();
		if (providers.length === 0) return [];

		const indexed = providers.map((provider, index) => ({ provider, index }));
		const searchResults = await PromiseUtils.mapConcurrent(
			indexed,
			serverConfig.plugins.providers.concurrency,
			async ({ provider, index }): Promise<AcceptedMatch | null> => {
				try {
					const results = await searchWithVariants((query) => provider.search(type, query, parsed.year), parsed.title, parsed.year);
					if (results.length === 0) return null;

					const ranked = rankCandidates(results, parsed.title, parsed.year);
					const best = ranked[0];
					const runnerUp = ranked[1];
					const acceptable =
						best != null &&
						(best.score >= CONFIDENT_MATCH_SCORE ||
							(best.score >= MIN_MATCH_SCORE && (!runnerUp || best.score - runnerUp.score >= MIN_SCORE_MARGIN)));

					if (!acceptable) {
						this.logger.debug("No confident metadata match, skipping provider", {
							providerId: provider.id,
							priorityIndex: index,
							title: parsed.title,
							year: parsed.year,
							topCandidate: best?.item.title,
							topCandidateScore: best?.score,
						});

						return null;
					}

					return { provider, index, bestMatch: best };
				} catch (error) {
					this.logger.warn("Metadata provider failed, trying next provider", {
						providerId: provider.id,
						priorityIndex: index,
						error: errorMessage(error),
					});

					return null;
				}
			},
		);

		return searchResults.filter((result) => isNotNullish(result)).toSorted((left, right) => left.index - right.index);
	}

	private async fetchDetailsOnce(type: "movie" | "tv_show", parsed: MediaIdentity): Promise<ProviderDetails[]> {
		this.publishSearchRequested(type, parsed.title, parsed.year);
		const accepted = await this.collectAcceptedMatches(type, parsed);

		for (const candidate of accepted) {
			const provider = candidate.provider;
			try {
				const metadata = await provider.getDetails(type, candidate.bestMatch.item.externalId);
				if (!metadata) continue;

				if (candidate.index > 0 || candidate.bestMatch.score < 0.8) {
					this.logger.debug("Metadata provider match selected", {
						providerId: provider.id,
						priority: await metadataProviderSettingsService.getPriority(provider.id),
						priorityIndex: candidate.index,
						matchedTitle: candidate.bestMatch.item.title,
						score: candidate.bestMatch.score,
						titleScore: candidate.bestMatch.titleScore,
						yearScore: candidate.bestMatch.yearScore,
					});
				}

				return [
					{
						provider: provider.id,
						metadata: normalizeMetadataDetails(metadata),
						matchScore: Math.min(1, Number(candidate.bestMatch.score.toFixed(3))),
					} satisfies ProviderDetails,
				];
			} catch (error) {
				this.logger.warn("Metadata provider details fetch failed, trying next provider", {
					providerId: provider.id,
					priorityIndex: candidate.index,
					error: errorMessage(error),
				});
			}
		}

		return [];
	}

	/**
	 * Fetches a season from every linked provider using that provider's own
	 * series id — a title may be anchored by one provider but its seasons may
	 * have come from another (lower-priority) provider, so a single external id
	 * cannot address all of them. Results are ordered by provider priority.
	 */
	async fetchSeasonFromLinks(links: readonly ProviderLink[], seasonNumber: number): Promise<ProviderSeasonDetails[]> {
		const ordered = await this.orderLinksByPriority(links);
		const key = `season:${ordered.map((link) => `${link.providerId}:${link.externalId}`).join(",")}:${seasonNumber}`;

		return await this.caches.season.getOrSet(key, () =>
			this.fetchFromProviderLinks(ordered, (provider, externalId) => provider.getSeasonDetails(externalId, seasonNumber)),
		);
	}

	async fetchEpisodeFromLinks(
		links: readonly ProviderLink[],
		seasonNumber: number,
		episodeNumber: number,
	): Promise<ProviderEpisodeDetails[]> {
		const ordered = await this.orderLinksByPriority(links);
		const key = `episode:${ordered.map((link) => `${link.providerId}:${link.externalId}`).join(",")}:${seasonNumber}:${episodeNumber}`;

		return await this.caches.episode.getOrSet(key, () =>
			this.fetchFromProviderLinks(ordered, (provider, externalId) => provider.getEpisodeDetails(externalId, seasonNumber, episodeNumber)),
		);
	}

	/**
	 * Fetches a single season from one provider's own namespace without requiring
	 * persisted provider links (plugin capability path). An empty result is cached
	 * too, so repeated misses don't re-hit the provider.
	 */
	async fetchSeasonByProvider(providerId: string, externalId: string, seasonNumber: number): Promise<ProviderSeasonResult | null> {
		if (!pluginRegistry.getProvider(providerId)) return null;

		const key = `season-direct:${await this.getProviderKey()}:${providerId}:${externalId}:${seasonNumber}`;
		const cached = this.caches.season.get(key);
		if (cached) return cached[0]?.metadata ?? null;

		const details = await this.fetchFromProviderLinks([{ providerId, externalId }], (provider, linkExternalId) =>
			provider.getSeasonDetails(linkExternalId, seasonNumber),
		);
		this.caches.season.set(key, details);

		return details[0]?.metadata ?? null;
	}

	async fetchPerson(externalId: string): Promise<ProviderPersonDetails[]> {
		const providerKey = await this.getProviderKey();
		const key = `${providerKey}:${externalId}`;

		return await this.caches.person.getOrSet(key, () =>
			this.fetchFromEveryProvider(async (provider) => {
				if (typeof provider.getPersonDetails === "function") {
					return await provider.getPersonDetails(externalId);
				}

				return null;
			}),
		);
	}

	/** Orders provider links by configured priority; links without a setting keep their relative order at the end. */
	private async orderLinksByPriority(links: readonly ProviderLink[]): Promise<ProviderLink[]> {
		const orderedIds = (await metadataProviderSettingsService.getOrderedProviders()).map((provider) => provider.id);
		const position = new Map(orderedIds.map((id, index) => [id, index] as const));

		return [...links].toSorted(
			(left, right) =>
				(position.get(left.providerId) ?? Number.MAX_SAFE_INTEGER) - (position.get(right.providerId) ?? Number.MAX_SAFE_INTEGER),
		);
	}

	/** Like {@link fetchFromEveryProvider}, but each provider is queried with its own external id. */
	private async fetchFromProviderLinks<TMetadata extends { name?: string | undefined; overview?: string | undefined }>(
		links: readonly ProviderLink[],
		fetchOne: (provider: MetadataProvider, externalId: string) => Promise<TMetadata | null | undefined>,
	): Promise<Array<{ provider: string; metadata: TMetadata }>> {
		const results = await PromiseUtils.mapConcurrent(links, serverConfig.plugins.providers.concurrency, async (link) => {
			const provider = pluginRegistry.getProvider(link.providerId);
			if (!provider) return null;

			try {
				const metadata = await fetchOne(provider, link.externalId);

				return metadata ? { provider: link.providerId, metadata: trimNameAndOverview(metadata) } : null;
			} catch (error) {
				this.logger.error(`Provider ${link.providerId} failed`, error);

				return null;
			}
		});

		return results.filter((result) => isNotNullish(result));
	}

	/**
	 * Calls `fetchOne` against every registered provider in parallel and returns
	 * the name/overview-trimmed results from providers that resolved to a value.
	 * A provider that throws, or resolves to `null`/`undefined` (no data for
	 * that provider), is simply omitted rather than failing the whole call.
	 */
	private async fetchFromEveryProvider<TMetadata extends { name?: string; overview?: string }>(
		fetchOne: (provider: ReturnType<typeof pluginRegistry.getProviders>[number]) => Promise<TMetadata | null | undefined>,
	): Promise<Array<{ provider: string; metadata: TMetadata }>> {
		const providers = await metadataProviderSettingsService.getOrderedProviders();
		const results = await PromiseUtils.mapConcurrent(providers, serverConfig.plugins.providers.concurrency, async (provider) => {
			try {
				const metadata = await fetchOne(provider);

				return metadata ? { provider: provider.id, metadata: trimNameAndOverview(metadata) } : null;
			} catch (error) {
				this.logger.error(`Provider ${provider.id} failed`, error);

				return null;
			}
		});

		return results.filter((result) => isNotNullish(result));
	}

	getAll(): MetadataProviderStatus[] {
		return pluginRegistry.getProviderStatus();
	}

	async getConfigurations(): Promise<MetadataProviderConfiguration[]> {
		return await metadataProviderSettingsService.list();
	}

	async reorderConfigurations(providerIds: readonly string[]): Promise<MetadataProviderConfiguration[]> {
		return await metadataProviderSettingsService.reorder(providerIds);
	}

	async updateConfiguration(providerId: string, values: { priority?: number; enabled?: boolean }): Promise<MetadataProviderConfiguration> {
		return await metadataProviderSettingsService.update(providerId, values);
	}

	private publishSearchRequested(type: "movie" | "tv_show", title: string, year?: number): void {
		pluginEventBus.publish("metadata.search.requested", { type, title, year });
	}
}

export const providerService = new ProviderService();
