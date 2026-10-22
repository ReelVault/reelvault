import { expect, setSystemTime, test } from "bun:test";
import Elysia from "elysia";
import { InMemoryRateLimiter } from "@/utils/in-memory.limiter";
import { domainErrorsMiddleware } from "./domain-errors.middleware";
import { isExemptFromGlobalLimit, rateLimitMiddleware } from "./rate-limit.middleware";

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
		.get("/v1/limited", () => "ok", { rateLimit: { name: "headers-test", max: 10, windowMs: 60_000 } });

	const res = await app.handle(new Request("http://localhost/v1/limited"));

	// The route's own budget is reported (10), not the global one every request also counts against.
	expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
	expect(res.headers.get("X-RateLimit-Remaining")).toBe("9");
	// A fresh window reports its full length in seconds.
	expect(res.headers.get("X-RateLimit-Reset")).toBe("60");
});

test("X-RateLimit headers are set on 429 rate limited responses", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(rateLimitMiddleware)
		.get("/limited", () => "ok", { rateLimit: { name: "headers-429-test", max: 1, windowMs: 60_000 } });

	// Pinned clock: the reset value is the full window, independent of how long the test takes.
	setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
	try {
		await app.handle(new Request("http://localhost/limited"));
		const limitedRes = await app.handle(new Request("http://localhost/limited"));

		expect(limitedRes.status).toBe(429);
		expect(limitedRes.headers.get("X-RateLimit-Limit")).toBe("1");
		expect(limitedRes.headers.get("X-RateLimit-Remaining")).toBe("0");
		expect(limitedRes.headers.get("X-RateLimit-Reset")).toBe("60");
	} finally {
		setSystemTime();
	}
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

test("page loads and SPA assets outside the API bypass the global limit", () => {
	expect(isExemptFromGlobalLimit(new Request("http://x/"))).toBe(true);
	expect(isExemptFromGlobalLimit(new Request("http://x/dashboard"))).toBe(true);
	expect(isExemptFromGlobalLimit(new Request("http://x/assets/app-123.js"))).toBe(true);
	expect(isExemptFromGlobalLimit(new Request("http://x/setup"))).toBe(true);

	// Only read-only document/asset loads — mutations and API calls stay limited.
	expect(isExemptFromGlobalLimit(new Request("http://x/upload", { method: "POST" }))).toBe(false);
	expect(isExemptFromGlobalLimit(new Request("http://x/v1/libraries"))).toBe(false);
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

	expect(limiter.has("k2")).toBe(false);
	expect(limiter.has("k1")).toBe(true);
	expect(limiter.has("k3")).toBe(true);
});

test("perParam gives each value of a route parameter its own bucket", async () => {
	const app = new Elysia()
		.use(domainErrorsMiddleware)
		.use(rateLimitMiddleware)
		.get("/plugins/:pluginId/run", () => "ok", { rateLimit: { name: "per-param-test", max: 1, windowMs: 60_000, perParam: "pluginId" } });

	const chattyFirst = await app.handle(new Request("http://localhost/plugins/chatty/run"));
	const chattySecond = await app.handle(new Request("http://localhost/plugins/chatty/run"));
	const quiet = await app.handle(new Request("http://localhost/plugins/quiet/run"));

	expect(chattyFirst.status).toBe(200);
	expect(chattySecond.status).toBe(429);
	expect(quiet.status).toBe(200);
});
