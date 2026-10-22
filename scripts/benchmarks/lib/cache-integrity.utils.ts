import type { ManagedServer } from "./server.launcher";

interface CacheStatsEntry {
	name: string;
	entries: number;
	hits: number;
}

/**
 * Proves that a `--no-cache` run really ran cold: every named `MemoryCache`
 * reports zero entries and zero hits. Misses are expected (they are the work
 * the run measures), and pending loads are ignored because they can settle
 * after the last measured request.
 *
 * A run with no registered caches proves nothing, so that is a failure too.
 */
export function assertColdCacheStats(stats: unknown, phase: string): number {
	if (!isCacheStatsBody(stats)) throw new Error(`[bench] ${phase}: cache-stats response has no memory array`);

	const warm = stats.memory.filter((cache) => cache.entries !== 0 || cache.hits !== 0);
	if (warm.length > 0) {
		const detail = warm.map((cache) => `${cache.name}(entries=${cache.entries}, hits=${cache.hits})`).join(", ");
		throw new Error(`[bench] ${phase}: --no-cache still had warm caches: ${detail}`);
	}
	if (stats.memory.length === 0) throw new Error(`[bench] ${phase}: no named MemoryCache registered, so cold storage is unverified`);

	return stats.memory.length;
}

/** Reads the admin cache-stats route; the caller decides whether the run must be cold. */
export async function fetchCacheStats(server: ManagedServer, cookie: string): Promise<unknown> {
	const response = await fetch(`${server.baseUrl}/v1/admin/cache-stats`, { headers: { cookie } });
	if (!response.ok) throw new Error(`[bench] cache-stats failed: HTTP ${response.status}`);

	return await response.json();
}

function isCacheStatsBody(value: unknown): value is { memory: CacheStatsEntry[] } {
	if (typeof value !== "object" || value === null) return false;
	const memory: unknown = (value as { memory?: unknown }).memory;

	return Array.isArray(memory) && memory.every((entry) => isCacheStatsEntry(entry));
}

function isCacheStatsEntry(value: unknown): value is CacheStatsEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as { name?: unknown; entries?: unknown; hits?: unknown };

	return typeof entry.name === "string" && typeof entry.entries === "number" && typeof entry.hits === "number";
}
