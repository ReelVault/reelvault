import type { BulkRefreshItem } from "@reelvault/sdk/common";
import type { ProviderSeasonResult } from "@reelvault/sdk/plugin";
import { providerService } from "@/plugins/capabilities/provider.service";
import { errorCodeOf } from "@/utils/domain.errors";
import { CATALOG_LIST_PATH_PREFIXES, invalidateResponseBodiesForPathPrefixes } from "@/utils/response-body.cache";

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

/** Fetches the episodes the linked providers list for one season, in the given language (the title's library language). */
export function seasonEpisodesFetcher(
	links: ReadonlyArray<{ providerId: string; externalId: string }>,
	language: string | undefined,
): (seasonNumber: number) => Promise<ProviderSeasonResult["episodes"]> {
	return async (seasonNumber) => (await fetchSeason(links, seasonNumber, language))?.episodes;
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

/**
 * Runs a bulk action over `ids` one after another (order preserved, duplicates
 * dropped): every item reports its own outcome and one failure never stops the
 * rest. Returns the same `{ results }` envelope every bulk endpoint expects.
 */
export async function runBulkItems(
	ids: readonly string[],
	runOne: (id: string) => Promise<unknown>,
	fallbackCode: string,
): Promise<{ results: BulkRefreshItem[] }> {
	const results: BulkRefreshItem[] = [];
	for (const id of new Set(ids)) {
		results.push(await runBulkItem(id, () => runOne(id), fallbackCode));
	}

	return { results };
}
