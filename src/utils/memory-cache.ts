import { MINUTE } from "@/server.constants";
import { detach } from "@/utils/promise.utils";

// Instances are module singletons, so holding these closures does not extend their lifetime.
interface MemoryCacheStats {
	name: string;
	entries: number;
	maxSize: number | null; // null = no limit
	hits: number;
	misses: number;
	hitRate: number | null; // null until first miss/hit is recorded
	evictions: number; // LRU + TTL only — explicit delete()/clear() don't count
	pendingLoads: number; // in-flight getOrSet() computations, deduped
}

const namedCaches = new Map<string, () => Omit<MemoryCacheStats, "name">>();

export function cacheRegistrySnapshot(): MemoryCacheStats[] {
	return [...namedCaches.entries()].map(([name, snapshot]) => ({ ...snapshot(), name })).toSorted((a, b) => a.name.localeCompare(b.name));
}

interface MemoryCacheOptions<T, K extends string> {
	/**
	 * Entry time-to-live in ms. Set to '-1' to disable expiration.
	 * @default 5 * 60 * 1000 // 5 minutes
	 */
	ttlMs?: number | undefined;
	/**
	 * Maximum number of entries (LRU eviction). Set to '-1' to disable the limit.
	 * @default 500
	 */
	maxSize?: number | undefined;
	/**
	 * How often (ms) to sweep for expired entries in the background.
	 * Only active when ttlMs is set (not -1). Set to 0 to disable.
	 * @default ttlMs (sweep once per TTL period)
	 */
	sweepIntervalMs?: number | undefined;
	/**
	 * Unique name to register this instance under the admin cache-stats registry.
	 * Instances without a name are not reported by cacheRegistrySnapshot().
	 */
	name?: string | undefined;
	/**
	 * Called synchronously whenever an entry leaves the cache (LRU eviction,
	 * TTL expiry via sweep/get, explicit delete/clear). Useful for releasing
	 * resources tied to a value (file handles, readable streams, timers).
	 * Errors thrown here are caught and ignored so cache internals stay consistent.
	 */
	onEvict?: ((key: K, value: T) => void) | undefined;
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number; // Number.POSITIVE_INFINITY when TTL is disabled
}

type EvictReason = "lru" | "ttl" | "delete" | "clear";

export class MemoryCache<T, K extends string = string> {
	private readonly cache = new Map<K, CacheEntry<T>>();
	private readonly ttlMs: number;
	private readonly maxSize: number;
	private readonly onEvict: ((key: K, value: T) => void) | undefined;
	private readonly registryName: string | undefined;
	private readonly registryEntry: (() => Omit<MemoryCacheStats, "name">) | undefined;
	private hits = 0;
	private misses = 0;
	private evictions = 0;
	private sweepTimer?: ReturnType<typeof setInterval> | undefined;

	// Deduplicates concurrent getOrSet() calls for the same key so the loader
	// runs once, not once-per-caller. Critical under parallel range-requests
	// (e.g. video seek firing several overlapping fetches for the same metadata).
	private readonly pending = new Map<K, Promise<T>>();

	constructor(options: MemoryCacheOptions<T, K> = {}) {
		this.ttlMs = options.ttlMs ?? 5 * MINUTE;
		this.maxSize = options.maxSize ?? 500;
		this.onEvict = options.onEvict;
		this.registryName = options.name;
		this.registryEntry = options.name ? () => this.stats() : undefined;
		if (this.registryName && this.registryEntry) namedCaches.set(this.registryName, this.registryEntry);

		// Active sweep so TTL-expired entries that are never read again don't leak memory.
		if (this.ttlMs !== -1) {
			const sweepMs = options.sweepIntervalMs ?? this.ttlMs;
			if (sweepMs > 0) {
				this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
				this.sweepTimer.unref();
			}
		}
	}

	get size(): number {
		return this.cache.size;
	}

	has(key: K): boolean {
		const entry = this.cache.get(key);
		if (!entry) return false;

		if (this.ttlMs === -1) return true;

		if (this.isExpired(entry)) {
			this.cache.delete(key);
			this.notifyEvict(key, entry.value, "ttl");

			return false;
		}

		return true;
	}

	get(key: K): T | null {
		const result = this.lookup(key);

		return result.hit ? result.value : null;
	}

	/**
	 * Presence-aware lookup. `get()` cannot distinguish a miss from a cached
	 * `null`, which broke negative caching (a cached "not found" was re-queried).
	 */
	private lookup(key: K): { hit: false } | { hit: true; value: T } {
		const entry = this.cache.get(key);
		if (!entry) {
			this.misses++;

			return { hit: false };
		}

		if (this.ttlMs !== -1 && this.isExpired(entry)) {
			this.cache.delete(key);
			this.misses++;
			this.notifyEvict(key, entry.value, "ttl");

			return { hit: false };
		}

		this.hits++;

		// LRU touch: move the entry to the end of the Map's insertion order
		this.cache.delete(key);
		this.cache.set(key, entry);

		return { hit: true, value: entry.value };
	}

	set(key: K, value: T): void {
		this.cache.delete(key); // reset position if the key already existed; overwriting isn't an eviction

		if (this.maxSize !== -1 && this.cache.size >= this.maxSize) {
			this.evictOldest();
		}

		const expiresAt = this.ttlMs === -1 ? Number.POSITIVE_INFINITY : Date.now() + this.ttlMs;
		this.cache.set(key, { value, expiresAt });
	}

	/**
	 * Returns the cached value if present and fresh; otherwise calls `loader`,
	 * caches the result, and returns it. Concurrent calls for the same key while
	 * a load is in flight share the same promise instead of triggering duplicate
	 * loads — important when many parallel requests (e.g. video byte-range
	 * fetches) miss the cache for the same key at once.
	 *
	 * Note on stats: each concurrent caller that misses still increments
	 * `misses` individually (via the internal `get()` call), even though only
	 * one of them actually triggers `loader`. `misses` reflects cache lookups,
	 * not loader invocations.
	 *
	 * If `loader` rejects, nothing is cached and the rejection propagates to all
	 * callers awaiting that key.
	 */
	getOrSet(key: K, loader: () => Promise<T>): Promise<T> {
		const cached = this.lookup(key);
		if (cached.hit) return Promise.resolve(cached.value);

		const inFlight = this.pending.get(key);
		if (inFlight) return inFlight;

		const promise = (async () => {
			try {
				const value = await loader();
				this.set(key, value);

				return value;
			} finally {
				this.pending.delete(key);
			}
		})();

		this.pending.set(key, promise);

		return promise;
	}

	/**
	 * Reads multiple keys at once. Missing/expired keys are simply absent from
	 * the returned Map (not set to null), so `result.has(key)` tells you what
	 * was found. Each lookup goes through `get()`, so LRU order and hit/miss
	 * stats update per key exactly as individual `get()` calls would.
	 */
	mget(keys: readonly K[]): Map<K, T> {
		const result = new Map<K, T>();
		for (const key of keys) {
			const value = this.get(key);
			if (value !== null) result.set(key, value);
		}

		return result;
	}

	/**
	 * Batch counterpart to `getOrSet`: resolves already-cached keys immediately
	 * and calls `loader` once with only the missing/expired keys, then caches
	 * and returns every requested key. Concurrent calls sharing a missing key
	 * with an in-flight `getOrSet`/`getOrSetMany` call for that key reuse the
	 * same pending promise instead of loading it twice.
	 *
	 * `loader` receives the list of missing keys and must return a Map (or
	 * entries array) covering all of them — any key it omits is left out of
	 * the result and NOT cached, so a subsequent call will try loading it again.
	 *
	 * If `loader` rejects, nothing new is cached and the rejection propagates
	 * to the caller; already-cached keys resolved before the call are not lost
	 * (they were never awaiting the loader in the first place).
	 */
	async getOrSetMany(
		keys: readonly K[],
		loader: (missingKeys: readonly K[]) => Promise<Map<K, T> | ReadonlyArray<readonly [K, T]>>,
	): Promise<Map<K, T>> {
		const result = this.mget(keys);
		const missing = keys.filter((key) => !result.has(key));
		if (missing.length === 0) return result;

		// Reuse in-flight single-key loads where possible; only ask the batch
		// loader for keys that are neither cached nor already being loaded.
		const awaitingPending: Array<[K, Promise<T>]> = [];
		const toLoad: K[] = [];
		for (const key of missing) {
			const inFlight = this.pending.get(key);
			if (inFlight) awaitingPending.push([key, inFlight]);
			else toLoad.push(key);
		}

		const [pendingResults, loaderResult] = await Promise.all([
			Promise.all(awaitingPending.map(async ([key, promise]) => [key, await promise] as const)),
			toLoad.length > 0 ? this.runBatchLoader(toLoad, loader) : Promise.resolve(new Map<K, T>()),
		]);

		for (const [key, value] of pendingResults) result.set(key, value);

		for (const [key, value] of loaderResult) result.set(key, value);

		return result;
	}

	delete(key: K): boolean {
		const entry = this.cache.get(key);
		const deleted = this.cache.delete(key);
		if (deleted && entry) this.notifyEvict(key, entry.value, "delete");

		return deleted;
	}

	clear(): void {
		if (this.onEvict) {
			for (const [key, entry] of this.cache) this.notifyEvict(key, entry.value, "clear");
		}

		this.cache.clear();
	}

	destroy(): void {
		clearInterval(this.sweepTimer);
		this.sweepTimer = undefined;
		this.clear();
		this.pending.clear();

		// Drop the admin-stats registration so dynamically named caches do not leak closures.
		if (this.registryName && namedCaches.get(this.registryName) === this.registryEntry) namedCaches.delete(this.registryName);
	}

	keys(): K[] {
		return [...this.cache.keys()];
	}

	values(): T[] {
		return [...this.cache.values()].map((entry) => entry.value);
	}

	entries(): Array<[K, T]> {
		return [...this.cache.entries()].map(([key, entry]) => [key, entry.value]);
	}

	stats(): Omit<MemoryCacheStats, "name"> {
		const total = this.hits + this.misses;

		return {
			entries: this.cache.size,
			maxSize: this.maxSize === -1 ? null : this.maxSize,
			hits: this.hits,
			misses: this.misses,
			hitRate: total === 0 ? null : Math.round((this.hits / total) * 1000) / 1000,
			evictions: this.evictions,
			pendingLoads: this.pending.size,
		};
	}

	private evictOldest(): void {
		// Prefer evicting an already-expired entry over a live one. Only the
		// oldest-inserted entry (front of the Map) is checked here — a full scan
		// would defeat the O(1) eviction cost; the periodic sweep handles the rest.
		if (this.ttlMs !== -1) {
			const oldest = this.cache.entries().next().value;
			if (oldest && this.isExpired(oldest[1])) {
				this.cache.delete(oldest[0]);
				this.notifyEvict(oldest[0], oldest[1].value, "ttl");

				return;
			}
		}

		const oldestKey = this.cache.keys().next().value;
		if (oldestKey === undefined) return;

		const oldestEntry = this.cache.get(oldestKey);
		this.cache.delete(oldestKey);
		if (oldestEntry) this.notifyEvict(oldestKey, oldestEntry.value, "lru");
	}

	private sweep(): void {
		const now = Date.now();
		for (const [key, entry] of this.cache) {
			if (this.isExpired(entry, now)) {
				this.cache.delete(key);
				this.notifyEvict(key, entry.value, "ttl");
			}
		}
	}

	private isExpired(entry: CacheEntry<T>, now = Date.now()): boolean {
		return entry.expiresAt !== Number.POSITIVE_INFINITY && now > entry.expiresAt;
	}

	// Runs the batch loader for `keys`, registering a per-key pending promise
	// for each one (resolved/rejected together with the batch) so a concurrent
	// single-key getOrSet() for the same key dedupes against this call instead
	// of triggering its own load.
	private async runBatchLoader(
		keys: readonly K[],
		loader: (missingKeys: readonly K[]) => Promise<Map<K, T> | ReadonlyArray<readonly [K, T]>>,
	): Promise<Map<K, T>> {
		const settled = new Map<K, T>();
		const batchPromise: Promise<Map<K, T>> = (async () => {
			const loaded = await loader(keys);
			const loadedMap = loaded instanceof Map ? loaded : new Map(loaded);
			for (const key of keys) {
				const value = loadedMap.get(key);
				if (value === undefined) continue;

				this.set(key, value);
				settled.set(key, value);
			}

			return settled;
		})();

		for (const key of keys) {
			const perKeyPromise = (async () => {
				const loadedMap = await batchPromise;
				const value = loadedMap.get(key);
				if (value === undefined) throw new Error(`getOrSetMany: loader did not return a value for key "${key}"`);

				return value;
			})();
			// Nobody may ever await this specific per-key promise (e.g. no concurrent
			// getOrSet() call arrives for this key), which would otherwise surface as
			// an unhandled rejection when the key is missing from the loader result.
			// allSettled observes the rejection without altering it for other awaiters.
			detach(Promise.allSettled([perKeyPromise]));
			this.pending.set(key, perKeyPromise);
		}

		try {
			return await batchPromise;
		} finally {
			for (const key of keys) this.pending.delete(key);
		}
	}

	private notifyEvict(key: K, value: T, reason: EvictReason): void {
		if (reason === "lru" || reason === "ttl") this.evictions++;

		if (!this.onEvict) return;

		try {
			this.onEvict(key, value);
		} catch {
			// onEvict must never break cache invariants
		}
	}
}
