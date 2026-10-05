import type { ProviderSeasonResult } from "@reelvault/sdk/plugin";
import { providerService } from "@/plugins/capabilities/provider.service";

/** Maps raw provider entries to the { providerId, externalId } shape used by fetcher APIs. */
export function mapProviderLinks(providers: ReadonlyArray<{ name: string; externalId: string }>) {
	return providers.map((provider) => ({ providerId: provider.name, externalId: provider.externalId }));
}

/** Extracts the first provider result that carries metadata. */
export function findFirstProviderResult<T extends { metadata?: unknown }>(results: T[]): T["metadata"] | undefined {
	return results.find((r) => r.metadata)?.metadata;
}

/** First season payload returned by the linked providers (results are pre-filtered to non-null metadata). */
export async function fetchSeason(
	links: ReadonlyArray<{ providerId: string; externalId: string }>,
	seasonNumber: number,
	language?: string,
): Promise<ProviderSeasonResult | undefined> {
	const providerSeasons = await providerService.fetchSeasonFromLinks(links, seasonNumber, language);

	return findFirstProviderResult(providerSeasons);
}

/** Deterministic season external id used when the provider has no season entry. */
export function fallbackSeasonExternalId(metadataId: string, seasonNumber: number | string): string {
	return `${metadataId}-s${seasonNumber}`;
}

/** Deterministic episode external id used when the provider has no episode entry. */
export function fallbackEpisodeExternalId(metadataId: string, seasonNumber: number | string, episodeNumber: number | string): string {
	return `${metadataId}-s${seasonNumber}-e${episodeNumber}`;
}
