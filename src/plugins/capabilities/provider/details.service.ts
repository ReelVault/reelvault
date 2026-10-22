import type { MediaIdentity, MetadataProviderSearchResponse } from "@reelvault/sdk/common";
import type { ExternalIdentifiers, ProviderMediaType, ProviderMetadataResult } from "@reelvault/sdk/plugin";
import { systemSettingsStore } from "@/config/system-settings.store";
import {
	type AggregatedMetadata,
	mergeProviderMetadata,
	type ProviderContribution,
} from "@/plugins/capabilities/metadata-aggregator.service";
import { metadataProviderSettingsService } from "@/plugins/capabilities/metadata-provider-settings.service";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { hasEntry } from "@/utils/array.utils";
import { DomainError, errorMessage } from "@/utils/domain.errors";
import { isAcceptableMatch } from "@/utils/media-match/ranking.utils";
import { isNullish, normalizeLower } from "@/utils/type.utils";
import { mapProvidersSafely } from "./fan-out.service";
import { providerCaches } from "./inflight.cache";
import { isExternalIdentifierAwareProvider, matchesExternalIdentifiers, normalizeMetadataDetails } from "./match-ranking.utils";
import { type AcceptedMatch, NoMatchError, type ProviderDetails } from "./provider.types";
import { getProviderKey, providerLog, publishSearchRequested, rankProviderResults } from "./provider-lookup.utils";

/**
 * Exact lookup of an id in one provider's own namespace — works with every
 * plugin, since `getDetails` is a required provider method. The id is passed
 * through verbatim: no provider names or id formats are known to the server.
 */
export async function searchByProviderExternalId(
	type: ProviderMediaType,
	providerId: string,
	externalId: string,
): Promise<MetadataProviderSearchResponse[]> {
	const enabled = await metadataProviderSettingsService.getOrderedProviders();
	const enabledIds = new Set(enabled.map((p) => p.id));
	if (!enabledIds.has(providerId)) {
		throw new DomainError("validation", `Provider ${providerId} is not registered or is disabled`, {
			code: "provider.unavailable",
			params: { provider: providerId },
		});
	}

	const metadata = await fetchDetailsByProvider(providerId, type, externalId);
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
export async function fetchDetails(type: "movie" | "tv_show", parsed: MediaIdentity): Promise<ProviderDetails[]> {
	const providerKey = await getProviderKey();
	const key = `${providerKey}:${type}:${normalizeLower(parsed.title)}:${parsed.year ?? ""}`;

	return await providerCaches().details.getOrSet(key, () => fetchDetailsOnce(type, parsed));
}

/**
 * Searches every enabled provider, then fetches and merges details from all
 * that produced an acceptable match. The result follows provider priority:
 * the highest-priority provider anchors each field, lower-priority providers
 * fill gaps, and ratings are collected from every source.
 */
export async function fetchAggregatedDetails(
	type: "movie" | "tv_show",
	parsed: MediaIdentity,
	options?: { libraryId?: string | undefined; language?: string | undefined },
): Promise<AggregatedMetadata | null> {
	// A library's own provider order and metadata language change the result, so both belong in the key.
	const providerKey = await getProviderKey(options?.libraryId);
	const libraryScope = options?.libraryId ? `:l:${options.libraryId}` : "";
	const language = options?.language;
	const key = `${providerKey}:${type}:${normalizeLower(parsed.title)}:${parsed.year ?? ""}${libraryScope}:${language ?? ""}`;

	try {
		return await providerCaches().aggregatedDetails.getOrSet(key, async () => {
			publishSearchRequested(type, parsed.title, parsed.year);
			const accepted = await collectAcceptedMatches(type, parsed, options?.libraryId, language);
			if (accepted.length === 0) throw new NoMatchError();

			const ordered = await mapProvidersSafely(
				accepted,
				async (candidate): Promise<ProviderContribution | null> => {
					const metadata = await candidate.provider.getDetails(
						type,
						candidate.bestMatch.item.externalId,
						language ? { language } : undefined,
					);
					if (!metadata) return null;

					return {
						providerId: candidate.provider.id,
						externalId: metadata.externalId,
						matchScore: Math.min(1, Number(candidate.bestMatch.score.toFixed(3))),
						metadata: normalizeMetadataDetails(metadata),
					};
				},
				(candidate, error) => {
					providerLog.logger.warn("Metadata provider details fetch failed during aggregation", {
						providerId: candidate.provider.id,
						priorityIndex: candidate.index,
						error: errorMessage(error),
					});
				},
			);
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
 * silently select a different title. The library's metadata language applies
 * here too, so a refresh returns the same language as the scan did.
 */
export async function fetchDetailsByProvider(
	providerId: string,
	type: "movie" | "tv_show",
	externalId: string,
	options: { language?: string | undefined } = {},
): Promise<ProviderMetadataResult | undefined> {
	const provider = pluginRegistry.getProvider(providerId);
	if (!provider) return undefined;

	try {
		const metadata = await provider.getDetails(type, externalId, options.language ? { language: options.language } : undefined);

		return metadata ? normalizeMetadataDetails(metadata) : undefined;
	} catch (error) {
		providerLog.logger.error(`Provider ${provider.id} failed`, error);

		return undefined;
	}
}

/**
 * The aggregated shape for one provider's exact title, for a title named by its id (a TMDB id in the file or
 * folder name). Cached per id, like title lookups. Absent when the provider does not know the id.
 */
export async function fetchAggregatedDetailsByProvider(
	ref: { providerId: string; type: "movie" | "tv_show"; externalId: string },
	options: { language?: string | undefined } = {},
): Promise<AggregatedMetadata | null> {
	const { providerId, type, externalId } = ref;
	const key = `by-id:${providerId}:${type}:${externalId}:${options.language ?? ""}`;

	try {
		return await providerCaches().aggregatedDetails.getOrSet(key, async () => {
			const metadata = await fetchDetailsByProvider(providerId, type, externalId, options);
			if (!metadata) throw new NoMatchError();

			return mergeProviderMetadata([{ providerId, externalId: metadata.externalId, matchScore: 1, metadata }]);
		});
	} catch (error) {
		if (error instanceof NoMatchError) return null;

		throw error;
	}
}

/** Resolves a title to the best matching provider's full metadata (no aggregation). */
export async function resolveDetails(type: ProviderMediaType, title: string, year?: number): Promise<ProviderMetadataResult | null> {
	const details = await fetchDetails(type, { title, type, year });

	return details[0]?.metadata ?? null;
}

export async function fetchDetailsByLocalIdentifiers(
	type: ProviderMediaType,
	identifiers: ExternalIdentifiers,
): Promise<ProviderDetails[]> {
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
	const results = await mapProvidersSafely(
		providers,
		async (provider) => {
			const metadata = await provider.getDetailsByExternalIds(type, identifiers);
			if (!(metadata && matchesExternalIdentifiers(provider.id, metadata, identifiers, identifierSet))) return null;

			return { provider: provider.id, metadata: normalizeMetadataDetails(metadata) } satisfies ProviderDetails;
		},
		(provider, error) => {
			providerLog.logger.warn("Metadata provider identifier lookup failed", {
				providerId: provider.id,
				error: errorMessage(error),
			});
		},
	);

	const firstMatch = results[0];

	return firstMatch ? [firstMatch] : [];
}

/**
 * Searches every enabled provider in parallel (bounded by configured
 * concurrency) and returns the confident matches sorted by provider priority.
 */
async function collectAcceptedMatches(
	type: "movie" | "tv_show",
	parsed: MediaIdentity,
	libraryId?: string,
	language?: string,
): Promise<AcceptedMatch[]> {
	const providers = await metadataProviderSettingsService.getOrderedProviders(libraryId);
	if (providers.length === 0) return [];

	const indexed = providers.map((provider, index) => ({ provider, index }));
	const searchResults = await mapProvidersSafely(
		indexed,
		async ({ provider, index }): Promise<AcceptedMatch | null> => {
			const ranked = await rankProviderResults(provider, { type, query: parsed.title, year: parsed.year, language }, (error) =>
				providerLog.logger.warn("Metadata provider failed, trying next provider", {
					providerId: provider.id,
					priorityIndex: index,
					error: errorMessage(error),
				}),
			);
			if (!ranked) return null;

			const best = ranked[0];
			const runnerUp = ranked[1];
			const acceptable = !isNullish(best) && isAcceptableMatch(best, runnerUp, systemSettingsStore.get("metadata.minMatchScore"));

			if (!acceptable) {
				providerLog.logger.debug("No confident metadata match, skipping provider", {
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
		},
		() => {
			// rankProviderResults reports per-provider failures through its own callback.
		},
	);

	return searchResults.toSorted((left, right) => left.index - right.index);
}

async function fetchDetailsOnce(type: "movie" | "tv_show", parsed: MediaIdentity): Promise<ProviderDetails[]> {
	publishSearchRequested(type, parsed.title, parsed.year);
	const accepted = await collectAcceptedMatches(type, parsed);

	for (const candidate of accepted) {
		const provider = candidate.provider;
		try {
			const metadata = await provider.getDetails(type, candidate.bestMatch.item.externalId);
			if (!metadata) continue;

			if (candidate.index > 0 || candidate.bestMatch.score < 0.8) {
				providerLog.logger.debug("Metadata provider match selected", {
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
			providerLog.logger.warn("Metadata provider details fetch failed, trying next provider", {
				providerId: provider.id,
				priorityIndex: candidate.index,
				error: errorMessage(error),
			});
		}
	}

	return [];
}
