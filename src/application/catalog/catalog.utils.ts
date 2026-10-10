import type { BulkRefreshItem } from "@reelvault/sdk/common";
import type { ProviderSeasonResult } from "@reelvault/sdk/plugin";
import { providerService } from "@/plugins/capabilities/provider.service";
import { errorCodeOf } from "@/utils/error-codes.utils";
import { CATALOG_LIST_PATH_PREFIXES, invalidateResponseBodiesForPathPrefixes } from "@/utils/response-body-cache";

/** Maps raw provider entries to the { providerId, externalId } shape used by fetcher APIs. */
export function mapProviderLinks(providers: ReadonlyArray<{ name: string; externalId: string }>) {
	return providers.map((provider) => ({ providerId: provider.name, externalId: provider.externalId }));
}

/** Extracts the first provider result that carries metadata. */
export function findFirstProviderResult<T extends { metadata?: unknown }>(results: T[]): T["metadata"] | undefined {
	return results.find((r) => r.metadata)?.metadata;
}

/** First provider entry per integer key (invalid or duplicate keys skipped) — O(1) lookup instead of `.find()` in nested loops. */
export function firstWinsByNumber<T>(items: readonly T[], keyOf: (item: T) => string | number | undefined): Map<number, T> {
	const map = new Map<number, T>();
	for (const item of items) {
		const key = Number(keyOf(item));
		if (Number.isInteger(key) && !map.has(key)) map.set(key, item);
	}

	return map;
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

/** Flushes cached catalog list responses after a write that changes what they embed. */
export function invalidateCatalogLists(): void {
	invalidateResponseBodiesForPathPrefixes(CATALOG_LIST_PATH_PREFIXES);
}

/**
 * Runs one item of a bulk action. A failure becomes the item's code (a domain error keeps its own code), so one
 * bad item never stops the rest of the selection, and no exception text is returned.
 */
export async function runBulkItem(id: string, refresh: () => Promise<unknown>, fallbackCode: string): Promise<BulkRefreshItem> {
	try {
		await refresh();

		return { id, ok: true };
	} catch (error) {
		return { id, ok: false, code: errorCodeOf(error, fallbackCode) };
	}
}
