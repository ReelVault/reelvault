import type {
	MediaIdentity,
	MetadataProviderConfiguration,
	MetadataProviderSearchRequest,
	MetadataProviderSearchResponse,
	MetadataProviderStatus,
} from "@reelvault/sdk/common";
import type {
	ExternalIdentifiers,
	ProviderDiscoveryRequest,
	ProviderDiscoveryResult,
	ProviderImageResult,
	ProviderMediaType,
	ProviderMetadataResult,
	ProviderResultGenre,
	ProviderSearchRequest,
	ProviderSearchResponse,
	ProviderSeasonResult,
} from "@reelvault/sdk/plugin";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { createLogger } from "@/utils/logger.utils";
import type { AggregatedMetadata } from "./metadata-aggregator.service";
import { metadataProviderSettingsService } from "./metadata-provider-settings.service";
import { discover, fetchImagesByProvider, fetchPerson, getGenres } from "./provider/catalog.service";
import {
	fetchAggregatedDetails,
	fetchAggregatedDetailsByProvider,
	fetchDetails,
	fetchDetailsByLocalIdentifiers,
	fetchDetailsByProvider,
	resolveDetails,
} from "./provider/details.service";
import { ProviderResultCaches } from "./provider/inflight.cache";
import { fetchEpisodeFromLinks, fetchSeasonByProvider, fetchSeasonFromLinks } from "./provider/links.service";
import type {
	ProviderDetails,
	ProviderEpisodeDetails,
	ProviderLink,
	ProviderPersonDetails,
	ProviderSeasonDetails,
} from "./provider/provider.types";
import { search, searchProviders } from "./provider/search.service";
import type { ProviderServiceState } from "./provider/shared.utils";

export type { ProviderDetails, ProviderEpisodeDetails, ProviderPersonDetails, ProviderSeasonDetails } from "./provider/provider.types";

class ProviderService {
	readonly serviceName = "ProviderService";

	readonly logger = createLogger("ProviderService");

	private readonly state: ProviderServiceState = { logger: this.logger, caches: new ProviderResultCaches() };

	/**
	 * Replaces the result caches. Their TTL is read when they are built, so a changed
	 * `plugins.providers.detailsCacheTtlMs` takes effect only through fresh caches.
	 */
	resetCaches(): void {
		this.state.caches = new ProviderResultCaches();
	}

	async search(request: MetadataProviderSearchRequest): Promise<MetadataProviderSearchResponse[]> {
		return await search(
			request,
			(...args) => this.searchProviders(...args),
			(...args) => this.fetchDetailsByProvider(...args),
		);
	}

	/**
	 * Title search across enabled providers (or a single `providerId`), with the
	 * provider's richer search result retained for callers that need artwork and
	 * popularity. Shared by the HTTP search endpoint and the plugin capability.
	 */
	async searchProviders(request: ProviderSearchRequest): Promise<ProviderSearchResponse[]> {
		return await searchProviders(this.state, request);
	}

	/** Deduplicates concurrent detail lookups for the same title/year so a burst of requests only hits providers once. */
	async fetchDetails(type: "movie" | "tv_show", parsed: MediaIdentity): Promise<ProviderDetails[]> {
		return await fetchDetails(this.state, type, parsed);
	}

	/**
	 * Searches every enabled provider, then fetches and merges details from all
	 * that produced an acceptable match. The result follows provider priority:
	 * the highest-priority provider anchors each field, lower-priority providers
	 * fill gaps, and ratings are collected from every source.
	 */
	async fetchAggregatedDetails(
		type: "movie" | "tv_show",
		parsed: MediaIdentity,
		options?: { libraryId?: string | undefined; language?: string | undefined },
	): Promise<AggregatedMetadata | null> {
		return await fetchAggregatedDetails(this.state, type, parsed, options);
	}

	/**
	 * Fetch a known provider entity without doing a title search first.
	 *
	 * This is used when refreshing already imported metadata: the persisted
	 * provider/external-ID pair is authoritative, while a new text search could
	 * silently select a different title. The library's metadata language applies
	 * here too, so a refresh returns the same language as the scan did.
	 */
	async fetchDetailsByProvider(
		providerId: string,
		type: "movie" | "tv_show",
		externalId: string,
		options: { language?: string | undefined } = {},
	): Promise<ProviderMetadataResult | undefined> {
		return await fetchDetailsByProvider(this.state, providerId, type, externalId, options);
	}

	/**
	 * The aggregated shape for one provider's exact title, for a title named by its id (a TMDB id in the file or
	 * folder name). Cached per id, like title lookups. Absent when the provider does not know the id.
	 */
	async fetchAggregatedDetailsByProvider(
		providerId: string,
		type: "movie" | "tv_show",
		externalId: string,
		options: { language?: string | undefined } = {},
	): Promise<AggregatedMetadata | null> {
		return await fetchAggregatedDetailsByProvider(this.state, { providerId, type, externalId }, options, (...args) =>
			this.fetchDetailsByProvider(...args),
		);
	}

	/** Resolves a title to the best matching provider's full metadata (no aggregation). */
	async resolveDetails(type: ProviderMediaType, title: string, year?: number): Promise<ProviderMetadataResult | null> {
		return await resolveDetails(type, title, year, (...args) => this.fetchDetails(...args));
	}

	/**
	 * Curated discovery feed (trending/popular/upcoming/…). Resolves through the
	 * enabled providers in priority order and returns the first provider that
	 * supports the category and yields items. Positive results are cached; a
	 * miss is retried on the next call so a temporarily down provider recovers.
	 */
	async discover(request: ProviderDiscoveryRequest): Promise<ProviderDiscoveryResult | null> {
		return await discover(this.state, request);
	}

	/** Genre catalogue from the first enabled provider that exposes it. */
	async getGenres(type: ProviderMediaType, providerId?: string): Promise<ProviderResultGenre[]> {
		return await getGenres(this.state, type, providerId);
	}

	async fetchDetailsByLocalIdentifiers(type: ProviderMediaType, identifiers: ExternalIdentifiers): Promise<ProviderDetails[]> {
		return await fetchDetailsByLocalIdentifiers(this.state, type, identifiers);
	}

	/** Fetches selectable artwork from one provider without changing persisted metadata. */
	async fetchImagesByProvider(providerId: string, type: "movie" | "tv_show", externalId: string): Promise<ProviderImageResult[]> {
		return await fetchImagesByProvider(this.state, providerId, type, externalId);
	}

	/**
	 * Fetches a season from every linked provider using that provider's own
	 * series id — a title may be anchored by one provider but its seasons may
	 * have come from another (lower-priority) provider, so a single external id
	 * cannot address all of them. Results are ordered by provider priority.
	 */
	async fetchSeasonFromLinks(links: readonly ProviderLink[], seasonNumber: number, language?: string): Promise<ProviderSeasonDetails[]> {
		return await fetchSeasonFromLinks(this.state, links, seasonNumber, language);
	}

	async fetchEpisodeFromLinks(
		links: readonly ProviderLink[],
		seasonNumber: number,
		episodeNumber: number,
		language?: string,
	): Promise<ProviderEpisodeDetails[]> {
		return await fetchEpisodeFromLinks(this.state, links, seasonNumber, episodeNumber, language);
	}

	/**
	 * Fetches a single season from one provider's own namespace without requiring
	 * persisted provider links (plugin capability path). An empty result is cached
	 * too, so repeated misses don't re-hit the provider.
	 */
	async fetchSeasonByProvider(providerId: string, externalId: string, seasonNumber: number): Promise<ProviderSeasonResult | null> {
		return await fetchSeasonByProvider(this.state, providerId, externalId, seasonNumber);
	}

	async fetchPerson(externalId: string): Promise<ProviderPersonDetails[]> {
		return await fetchPerson(this.state, externalId);
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
}

export const providerService = new ProviderService();
