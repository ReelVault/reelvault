/**
 * Layered cache for the SDK client.
 *
 * - `InFlightDeduper` shares in-flight GET requests with the same key so
 *   concurrent callers do not duplicate network work.
 * - `TtlCache` stores successful GET results for a bounded time.
 *
 * Both structures are shared globally across every resource of the client
 * (passed down through the shared HttpClient).
 */
export class InFlightDeduper {
	private readonly pending = new Map<string, Promise<unknown>>();

	get(key: string): Promise<unknown> | undefined {
		return this.pending.get(key);
	}

	track(key: string, promise: Promise<unknown>): void {
		this.pending.set(key, promise);
	}

	untrack(key: string): void {
		this.pending.delete(key);
	}

	clear(): void {
		this.pending.clear();
	}
}

export class TtlCache {
	/** Bound: without a cap, distinct URLs accumulate for the process lifetime. */
	private static readonly MAX_ENTRIES = 500;
	private readonly store = new Map<string, { value: unknown; expiresAt: number }>();

	get(key: string): unknown {
		const entry = this.store.get(key);
		if (!entry) return undefined;

		if (entry.expiresAt <= Date.now()) {
			this.store.delete(key);

			return undefined;
		}

		// Clone on read so a caller mutating the resolved value cannot corrupt the
		// cache (and every later caller) for the TTL window.
		return cloneCacheValue(entry.value);
	}

	set(key: string, value: unknown, ttlMs: number): void {
		if (ttlMs <= 0) return;

		if (this.store.has(key)) {
			this.store.delete(key); // refresh insertion order (LRU)
		} else if (this.store.size >= TtlCache.MAX_ENTRIES) {
			const oldest = this.store.keys().next().value;
			if (oldest !== undefined) this.store.delete(oldest);
		}

		this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
	}

	delete(key: string): void {
		this.store.delete(key);
	}

	clear(): void {
		this.store.clear();
	}
}

function cloneCacheValue<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;

	try {
		return structuredClone(value);
	} catch {
		// Non-cloneable payload (e.g. a Blob) — return as-is rather than throwing.
		return value;
	}
}
