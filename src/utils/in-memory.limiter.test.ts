import { expect, test } from "bun:test";
import { InMemoryRateLimiter } from "./in-memory.limiter";

test("a bucket whose window is longer than the sweep interval survives a sweep", () => {
	const limiter = new InMemoryRateLimiter();
	const windowMs = 10 * 60_000;

	expect(limiter.consume("k", 1, windowMs, 0).allowed).toBe(true);
	// Sweep 70 s later — past the 60 s cleanup interval but well inside the 10 min window.
	limiter.sweep(70_000);

	const second = limiter.consume("k", 1, windowMs, 70_000);
	expect(second.allowed).toBe(false);
});

test("InMemoryRateLimiter keeps buckets in LRU order and evicts the least recently accessed", () => {
	const limiter = new InMemoryRateLimiter();
	const windowMs = 60_000;

	// Three buckets, then touch k1 so k2 is the least recently accessed.
	limiter.consume("k1", 10, windowMs, 1000);
	limiter.consume("k2", 10, windowMs, 2000);
	limiter.consume("k3", 10, windowMs, 3000);

	// Touch k1 so it becomes newer than k2
	limiter.consume("k1", 10, windowMs, 4000);

	// Public evictOldest: k2 should be evicted (oldest access was 2000, k1 was 4000, k3 was 3000)
	limiter.evictOldest();

	expect(limiter.peek("k2", 10, 4000)).toBeUndefined();
	expect(limiter.peek("k1", 10, 4000)?.count).toBe(2);
	expect(limiter.peek("k3", 10, 4000)?.count).toBe(1);
});
