import { expect, test } from "bun:test";
import Elysia from "elysia";
import { domainErrorsMiddleware } from "./domain-errors.middleware";
import { InMemoryRateLimiter, isExemptFromGlobalLimit, rateLimitMiddleware } from "./rate-limit.middleware";

test("rate limit middleware limits a route within a fixed window", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(rateLimitMiddleware)
		.get("/limited", () => "ok", { rateLimit: { name: "rate-limit-test", max: 2, windowMs: 60_000 } });

	const first = await app.handle(new Request("http://localhost/limited"));
	const second = await app.handle(new Request("http://localhost/limited"));
	const third = await app.handle(new Request("http://localhost/limited"));

	expect(first.status).toBe(200);
	expect(second.status).toBe(200);
	expect(third.status).toBe(429);
});

test("per-route rate limit is keyed by identity — different users get separate buckets", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(rateLimitMiddleware)
		.derive(({ request }) => {
			const userId = request.headers.get("x-user-id");

			return { user: userId ? { id: userId, role: "user" } : null };
		})
		.get("/limited", () => "ok", { rateLimit: { name: "per-user-test", max: 2, windowMs: 60_000 } });

	const headersA = { "x-user-id": "user-a" };
	const headersB = { "x-user-id": "user-b" };

	const a1 = await app.handle(new Request("http://localhost/limited", { headers: headersA }));
	const a2 = await app.handle(new Request("http://localhost/limited", { headers: headersA }));
	const a3 = await app.handle(new Request("http://localhost/limited", { headers: headersA }));

	expect(a1.status).toBe(200);
	expect(a2.status).toBe(200);
	expect(a3.status).toBe(429);

	const b1 = await app.handle(new Request("http://localhost/limited", { headers: headersB }));
	expect(b1.status).toBe(200);
});

test("per-route rate limit falls back to anonymous when no user", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(rateLimitMiddleware)
		.get("/limited", () => "ok", { rateLimit: { name: "anon-test", max: 1, windowMs: 60_000 } });

	const first = await app.handle(new Request("http://localhost/limited"));
	const second = await app.handle(new Request("http://localhost/limited"));

	expect(first.status).toBe(200);
	expect(second.status).toBe(429);
});

test("a forged X-Forwarded-For cannot buy a fresh anonymous bucket", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(rateLimitMiddleware)
		.get("/limited", () => "ok", { rateLimit: { name: "xff-test", max: 1, windowMs: 60_000 } });

	const first = await app.handle(new Request("http://localhost/limited", { headers: { "x-forwarded-for": "1.1.1.1" } }));
	const second = await app.handle(new Request("http://localhost/limited", { headers: { "x-forwarded-for": "2.2.2.2" } }));

	expect(first.status).toBe(200);
	expect(second.status).toBe(429);
});

test("adminBypass skips rate limiting for admin users", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(rateLimitMiddleware)
		.derive(() => ({
			user: { id: "admin-1", role: "admin" },
		}))
		.get("/limited", () => "ok", { rateLimit: { name: "admin-bypass-test", max: 1, windowMs: 60_000, adminBypass: true } });

	const results = await Promise.all([
		app.handle(new Request("http://localhost/limited")),
		app.handle(new Request("http://localhost/limited")),
		app.handle(new Request("http://localhost/limited")),
	]);

	for (const res of results) expect(res.status).toBe(200);
});

test("adminBypass does not skip rate limiting for non-admin users", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(rateLimitMiddleware)
		.derive(() => ({
			user: { id: "user-1", role: "user" },
		}))
		.get("/limited", () => "ok", { rateLimit: { name: "admin-no-bypass-test", max: 2, windowMs: 60_000, adminBypass: true } });

	const first = await app.handle(new Request("http://localhost/limited"));
	const second = await app.handle(new Request("http://localhost/limited"));
	const third = await app.handle(new Request("http://localhost/limited"));

	expect(first.status).toBe(200);
	expect(second.status).toBe(200);
	expect(third.status).toBe(429);
});

test("X-RateLimit headers are set on successful responses", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(rateLimitMiddleware)
		.get("/limited", () => "ok", { rateLimit: { name: "headers-test", max: 10, windowMs: 60_000 } });

	const res = await app.handle(new Request("http://localhost/limited"));

	const limit = Number(res.headers.get("X-RateLimit-Limit"));
	const remaining = Number(res.headers.get("X-RateLimit-Remaining"));
	const reset = Number(res.headers.get("X-RateLimit-Reset"));
	expect(limit).toBeGreaterThan(0);
	expect(remaining).toBeGreaterThanOrEqual(0);
	expect(remaining).toBeLessThan(limit);
	expect(reset).toBeGreaterThan(0);
});

test("X-RateLimit headers are set on 429 rate limited responses", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(rateLimitMiddleware)
		.get("/limited", () => "ok", { rateLimit: { name: "headers-429-test", max: 1, windowMs: 60_000 } });

	await app.handle(new Request("http://localhost/limited"));
	const limitedRes = await app.handle(new Request("http://localhost/limited"));

	expect(limitedRes.status).toBe(429);
	expect(limitedRes.headers.get("X-RateLimit-Limit")).toBe("1");
	expect(limitedRes.headers.get("X-RateLimit-Remaining")).toBe("0");
	expect(Number(limitedRes.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(0);
});

test("a bucket whose window is longer than the sweep interval survives a sweep", () => {
	const limiter = new InMemoryRateLimiter();
	const windowMs = 10 * 60_000;

	expect(limiter.consume("k", 1, windowMs, 0).allowed).toBe(true);
	// Sweep 70 s later — past the 60 s cleanup interval but well inside the 10 min window.
	limiter.sweep(70_000);

	const second = limiter.consume("k", 1, windowMs, 70_000);
	expect(second.allowed).toBe(false);
});

test("global-limit exemptions match the pathname, never the query string", () => {
	expect(isExemptFromGlobalLimit(new Request("http://x/v1/health?fresh=true"))).toBe(true);
	expect(isExemptFromGlobalLimit(new Request("http://x/v1/images/poster.jpg"))).toBe(true);
	expect(isExemptFromGlobalLimit(new Request("http://x/v1/playback-sessions/s1/segments/12"))).toBe(true);

	// Crafted query strings must not buy an exemption.
	expect(isExemptFromGlobalLimit(new Request("http://x/v1/media-files?x=/segments/"))).toBe(false);
	expect(isExemptFromGlobalLimit(new Request("http://x/v1/media-files?x=/v1/images/"))).toBe(false);
	expect(isExemptFromGlobalLimit(new Request("http://x/v1/healthcheck"))).toBe(false);
});

test("InMemoryRateLimiter keeps buckets in LRU order and evicts the least recently accessed", () => {
	const limiter = new InMemoryRateLimiter();
	const windowMs = 60_000;

	// Fill buckets up to capacity using mocked maxBuckets or testing internal eviction
	limiter.consume("k1", 10, windowMs, 1000);
	limiter.consume("k2", 10, windowMs, 2000);
	limiter.consume("k3", 10, windowMs, 3000);

	// Touch k1 so it becomes newer than k2
	limiter.consume("k1", 10, windowMs, 4000);

	// Public evictOldest: k2 should be evicted (oldest access was 2000, k1 was 4000, k3 was 3000)
	limiter.evictOldest();

	expect(limiter.has("k2")).toBe(false);
	expect(limiter.has("k1")).toBe(true);
	expect(limiter.has("k3")).toBe(true);
});
