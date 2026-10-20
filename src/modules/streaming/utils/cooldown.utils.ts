import { MemoryCache } from "@/utils/memory.cache";

export interface CooldownCheck {
	allowed: boolean;
	/** Milliseconds until the key may be used again; 0 when allowed. */
	retryAfterMs: number;
}

interface CooldownMapOptions {
	cooldownMs: number;
	maxEntries: number;
	now?: (() => number) | undefined;
}

/**
 * Per-key cooldown gate: records when a key's attempt was last accepted and
 * reports how long the next one must wait.
 *
 * The entries live in a bounded cache whose time-to-live is the cooldown
 * itself, so an entry can never outlive the window in which it blocks an
 * attempt — the memory is reclaimed by the cache, not by a manual sweep.
 */
export class CooldownMap {
	private readonly entries: MemoryCache<number>;
	private readonly cooldownMs: number;
	private readonly now: () => number;

	constructor(options: CooldownMapOptions) {
		this.cooldownMs = options.cooldownMs;
		this.now = options.now ?? Date.now;
		this.entries = new MemoryCache<number>({ ttlMs: options.cooldownMs, maxSize: options.maxEntries });
	}

	get size(): number {
		return this.entries.size;
	}

	/** Records the attempt when the key is off cooldown; otherwise reports the remaining wait. */
	tryBegin(key: string): CooldownCheck {
		const now = this.now();
		const last = this.entries.get(key);
		if (last !== null && now - last < this.cooldownMs) {
			return { allowed: false, retryAfterMs: this.cooldownMs - (now - last) };
		}

		this.entries.set(key, now);

		return { allowed: true, retryAfterMs: 0 };
	}

	invalidate(key: string): void {
		this.entries.delete(key);
	}
}
