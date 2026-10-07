import { describe, expect, test } from "bun:test";
import Elysia from "elysia";
import { responseCacheMiddleware } from "./response-cache.middleware";

const ETAG_PATTERN = /^"[0-9a-f]+"$/;

function makeApp() {
	return new Elysia()
		.use(responseCacheMiddleware)
		.get("/cached", () => ({ data: "cached" }), { cache: { maxAge: 60, private: true } })
		.get("/public", () => ({ data: "public" }), { cache: { maxAge: 60 } });
}

describe("responseCacheMiddleware", () => {
	test("serves the cached body with the unified Vary and Content-Type headers", async () => {
		const app = makeApp();
		const first = await app.handle(new Request("http://localhost/cached"));
		const second = await app.handle(new Request("http://localhost/cached"));

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await second.text()).toBe(JSON.stringify({ data: "cached" }));
		expect(first.headers.get("Vary")).toBe("Accept-Encoding, Cookie");
		expect(first.headers.get("Content-Type")).toBe("application/json; charset=utf-8");

		const publicResponse = await app.handle(new Request("http://localhost/public"));
		expect(publicResponse.headers.get("Vary")).toBe("Accept-Encoding");
	});

	test("answers 304 for weak and comma-separated If-None-Match validators", async () => {
		const app = makeApp();
		const first = await app.handle(new Request("http://localhost/cached"));
		const etag = first.headers.get("ETag") as string;
		expect(etag).toMatch(ETAG_PATTERN);

		for (const header of [`W/${etag}`, `"stale", ${etag}`]) {
			const response = await app.handle(new Request("http://localhost/cached", { headers: { "if-none-match": header } }));
			expect(response.status).toBe(304);
		}
	});

	test("keeps different API keys apart in the shared body cache", async () => {
		const app = new Elysia().use(responseCacheMiddleware).get("/identity", ({ request }) => ({ key: request.headers.get("x-api-key") }), {
			cache: { maxAge: 60, private: true },
		});

		const first = await app.handle(new Request("http://localhost/identity", { headers: { "x-api-key": "rv_key-a" } }));
		const second = await app.handle(new Request("http://localhost/identity", { headers: { "x-api-key": "rv_key-b" } }));

		expect(await first.json()).toEqual({ key: "rv_key-a" });
		expect(await second.json()).toEqual({ key: "rv_key-b" });
	});
});
