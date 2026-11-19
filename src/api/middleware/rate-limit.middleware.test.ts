import { beforeEach, expect, setSystemTime, test } from "bun:test";
import Elysia from "elysia";
import { domainErrorsMiddleware } from "./domain-errors.middleware";
import { clearRateLimitBuckets, isExemptFromGlobalLimit, rateLimitMiddleware } from "./rate-limit.middleware";

// Budgets are process-wide: every file in one run shares them, so each test starts with an empty limiter.
beforeEach(() => {
	clearRateLimitBuckets();
});

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
