import { BoundedMap } from "@/modules/streaming/utils/bounded-map.utils";

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
 * Per-key cooldown gate over a bounded map: records when a key's attempt was
 * last accepted and reports how long the next one must wait. Pruning is
 * explicit — callers decide how long entries may linger.
 */
export class CooldownMap {
	private readonly entries: BoundedMap<number>;
	private readonly cooldownMs: number;
	private readonly now: () => number;

	constructor(options: CooldownMapOptions) {
		this.cooldownMs = options.cooldownMs;
		this.now = options.now ?? Date.now;
		this.entries = new BoundedMap({ maxEntries: options.maxEntries, now: this.now });
	}

	get size(): number {
		return this.entries.size;
	}

	/** Records the attempt when the key is off cooldown; otherwise reports the remaining wait. */
	tryBegin(key: string): CooldownCheck {
		const now = this.now();
		const last = this.entries.get(key);
		if (last !== undefined && now - last < this.cooldownMs) {
			return { allowed: false, retryAfterMs: this.cooldownMs - (now - last) };
		}

		this.entries.set(key, now);

		return { allowed: true, retryAfterMs: 0 };
	}

	invalidate(key: string): void {
		this.entries.delete(key);
	}

	/** Drops entries whose cooldown has elapsed — they can no longer block an attempt. */
	pruneElapsed(): void {
		this.entries.prune((time, now) => now - time >= this.cooldownMs);
	}

	pruneOlderThan(ms: number): void {
		this.entries.prune((time, now) => now - time > ms);
	}
}
