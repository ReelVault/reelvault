import { isNotNullish } from "@/utils/array.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { isRecord } from "@/utils/type.utils";

// Paginated lists re-run the same COUNT every page. The count scan (often with
// a correlated EXISTS per row) is serialized onto the same connection as the
// page query, so it lands directly in page latency. A short TTL keeps totals
// accurate enough for pagination UIs while removing the scan from pages 2+.
// Approved contract change (2026-09): totals may be up to 10 s stale.
const countCache = new MemoryCache<number>({ ttlMs: 10_000, maxSize: 500, name: "db.count" });

function countCacheKey(tableName: string, filters: unknown): string {
	// Raw string key — micro-benchmarked ~7x faster than bunHash->hex on this
	// hot path (scripts/benchmarks/micro.ts); Map keys need no normalization.
	return `${tableName}:${JSON.stringify(filters ?? null)}`;
}

/**
 * Extracts only the filter values declared in the query map. The parsed
 * `filters` value is the raw request query, so hashing it directly folded
 * `page`/`limit`/`sortBy`/`fields` into the COUNT cache key and made every page
 * a cache miss.
 */
export function filterSignature(filters: unknown, filterMap: Record<string, unknown>): Array<[string, unknown]> {
	if (!isRecord(filters)) return [];

	return Object.keys(filterMap)
		.map((key): [string, unknown] => [key, filters[key]])
		.filter(([, value]) => isNotNullish(value));
}

/**
 * COUNT for paginated lists with a 10 s per-filter cache (see countCache).
 * Uses getOrSet to deduplicate concurrent identical count queries.
 */
export async function cachedCount(tableName: string, filters: unknown, runCount: () => Promise<number>): Promise<number> {
	const key = countCacheKey(tableName, filters);

	return await countCache.getOrSet(key, runCount);
}

/** Drops every cached COUNT. Tests call it between cases so one case's totals never answer for the next. */
export function clearCountCache(): void {
	countCache.clear();
}
