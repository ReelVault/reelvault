import { serverConfig } from "@/server.config";

export class InMemoryRateLimiter {
	private readonly buckets = new Map<string, { startedAt: number; lastAccess: number; count: number; windowMs: number }>();

	constructor() {
		setInterval(() => this.sweep(Date.now()), serverConfig.api.rateLimit.cleanupWindowMs).unref();
	}

	consume(key: string, max: number, windowMs: number, now = Date.now()): { allowed: boolean; remaining: number; resetMs: number } {
		const current = this.buckets.get(key);
		if (!current || now - current.startedAt >= windowMs) {
			if (current) this.buckets.delete(key);

			if (this.buckets.size >= serverConfig.api.rateLimit.maxBuckets) {
				this.evictOldest();
			}

			this.buckets.set(key, { startedAt: now, lastAccess: now, count: 1, windowMs });

			return { allowed: true, remaining: max - 1, resetMs: windowMs };
		}

		// Re-insert to keep LRU order (most recently accessed at the tail).
		this.buckets.delete(key);
		current.lastAccess = now;

		if (current.count >= max) {
			this.buckets.set(key, current);
			const resetMs = windowMs - (now - current.startedAt);

			return { allowed: false, remaining: 0, resetMs };
		}

		current.count += 1;
		this.buckets.set(key, current);

		return { allowed: true, remaining: max - current.count, resetMs: windowMs - (now - current.startedAt) };
	}

	has(key: string): boolean {
		return this.buckets.has(key);
	}

	clear(): void {
		this.buckets.clear();
	}

	evictOldest(): void {
		const oldestKey = this.buckets.keys().next().value;
		if (oldestKey !== undefined) this.buckets.delete(oldestKey);
	}

	sweep(now: number): void {
		// Expire against each bucket's OWN window — the sweep interval
		// (cleanupWindowMs) can be shorter than a route's window, and deleting a
		// live bucket would silently reset its counter.
		for (const [key, bucket] of this.buckets) {
			if (now - bucket.startedAt >= bucket.windowMs) this.buckets.delete(key);
		}
	}
}
