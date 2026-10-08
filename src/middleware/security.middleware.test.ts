import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import Elysia from "elysia";
import { env } from "@/env";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
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

test("securityHeadersMiddleware adds plugin-declared CSP sources to the web UI policy", async () => {
	const app = new Elysia().use(securityHeadersMiddleware).get("/test", () => "hello");
	const previousDist = env.APP_WEB_DIST;
	env.APP_WEB_DIST = tmpdir();

	try {
		pluginRegistry.begin({
			id: "org.example.csp",
			name: "CSP plugin",
			version: "1.0.0",
			entry: "./dist/index.js",
			capabilities: [],
			csp: { "img-src": ["https://images.example.com"] },
		});

		const res = await app.handle(new Request("http://localhost/test"));

		const csp = res.headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain("img-src 'self' data: blob: https://api.dicebear.com https://images.example.com");
	} finally {
		pluginRegistry.unregister("org.example.csp");
		env.APP_WEB_DIST = previousDist;
	}
});
