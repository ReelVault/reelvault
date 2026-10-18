/** Point-in-time view of one named cache, as the admin cache-stats page shows it. */
export interface MemoryCacheStats {
	name: string;
	entries: number;
	maxSize: number | null; // null = no limit
	hits: number;
	misses: number;
	hitRate: number | null; // null until first miss/hit is recorded
	evictions: number; // LRU + TTL only — explicit delete()/clear() don't count
	pendingLoads: number; // in-flight getOrSet() computations, deduped
}

type StatsSnapshot = () => Omit<MemoryCacheStats, "name">;

// Instances are module singletons, so holding these closures does not extend their lifetime.
const namedCaches = new Map<string, StatsSnapshot>();

/** Registers a named cache's stats under its name, replacing any earlier registration. */
export function registerNamedCache(name: string, snapshot: StatsSnapshot): void {
	namedCaches.set(name, snapshot);
}

/** Drops a registration, but only when it is still the one this snapshot made. */
export function unregisterNamedCache(name: string, snapshot: StatsSnapshot | undefined): void {
	if (namedCaches.get(name) === snapshot) namedCaches.delete(name);
}

export function cacheRegistrySnapshot(): MemoryCacheStats[] {
	return [...namedCaches.entries()].map(([name, snapshot]) => ({ ...snapshot(), name })).toSorted((a, b) => a.name.localeCompare(b.name));
}
