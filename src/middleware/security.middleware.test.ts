import { expect, test } from "bun:test";
import Elysia from "elysia";
import { responseCacheMiddleware } from "./response-cache.middleware";
import { securityHeadersMiddleware } from "./security.middleware";

test("securityHeadersMiddleware sets default security headers", async () => {
	const app = new Elysia().use(securityHeadersMiddleware).get("/test", () => "hello");

	const res = await app.handle(new Request("http://localhost/test"));

	expect(res.status).toBe(200);
	expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	expect(res.headers.get("X-Frame-Options")).toBe("DENY");
	expect(res.headers.get("Cache-Control")).toBe("no-store");
});

test("securityHeadersMiddleware lets the host website frame plugin UI assets", async () => {
	const app = new Elysia().use(securityHeadersMiddleware).get("/v1/plugins/ui/:pluginId/*", () => "asset");

	const res = await app.handle(new Request("http://localhost/v1/plugins/ui/org.example.plugin/dist/ui/index.html"));

	expect(res.headers.get("X-Frame-Options")).toBeNull();
	const csp = res.headers.get("Content-Security-Policy") ?? "";
	expect(csp).toContain("frame-ancestors *");
	expect(csp).not.toContain("frame-ancestors 'none'");
});

test("securityHeadersMiddleware does not overwrite Cache-Control from responseCacheMiddleware", async () => {
	const app = new Elysia()
		.use(securityHeadersMiddleware)
		.use(responseCacheMiddleware)
		.get("/cached", () => ({ data: "cached" }), { cache: { maxAge: 120 } });

	const res = await app.handle(new Request("http://localhost/cached"));

	expect(res.status).toBe(200);
	expect(res.headers.get("Cache-Control")).toBe("public, max-age=120");
});

test("securityHeadersMiddleware sets Cache-Control to no-store on error responses even if cache was configured", async () => {
	const app = new Elysia()
		.use(securityHeadersMiddleware)
		.use(responseCacheMiddleware)
		.get(
			"/error-cached",
			({ set }) => {
				set.status = 500;

				return { error: "failed" };
			},
			{ cache: { maxAge: 120 } },
		);

	const res = await app.handle(new Request("http://localhost/error-cached"));

	expect(res.status).toBe(500);
	expect(res.headers.get("Cache-Control")).toBe("no-store");
});
