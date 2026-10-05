export interface BoundedMapOptions {
	/** Hard entry cap; setting a new key at capacity evicts the oldest entry first. */
	maxEntries: number;
	/** Injectable clock for prune(); defaults to Date.now. */
	now?: (() => number) | undefined;
}

/**
 * Insertion-ordered map with a hard entry cap and explicit pruning. Re-setting
 * an existing key touches it (moves it to the newest slot) without evicting
 * another entry; `prune` drops entries matching the caller's expiry policy.
 */
export class BoundedMap<V> {
	private readonly entries = new Map<string, V>();
	private readonly maxEntries: number;
	private readonly now: () => number;

	constructor(options: BoundedMapOptions) {
		this.maxEntries = options.maxEntries;
		this.now = options.now ?? Date.now;
	}

	get size(): number {
		return this.entries.size;
	}

	get(key: string): V | undefined {
		return this.entries.get(key);
	}

	set(key: string, value: V): void {
		// Drop first so re-setting a key cannot evict a different entry, and the
		// key lands in the newest position (Map.set keeps the old slot otherwise).
		this.entries.delete(key);
		if (this.entries.size >= this.maxEntries) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey !== undefined) this.entries.delete(oldestKey);
		}

		this.entries.set(key, value);
	}

	delete(key: string): void {
		this.entries.delete(key);
	}

	prune(isExpired: (value: V, now: number) => boolean): void {
		const now = this.now();
		for (const [key, value] of this.entries) {
			if (isExpired(value, now)) this.entries.delete(key);
		}
	}
}
