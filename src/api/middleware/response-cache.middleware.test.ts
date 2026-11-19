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
	test("answers a repeat request from the body cache without running the handler again", async () => {
		let runs = 0;
		const app = new Elysia()
			.use(responseCacheMiddleware)
			.get("/repeat-from-cache", () => ({ run: ++runs }), { cache: { maxAge: 60, private: true } });

		await app.handle(new Request("http://localhost/repeat-from-cache"));
		const second = await app.handle(new Request("http://localhost/repeat-from-cache"));

		expect(runs).toBe(1);
		expect(second.status).toBe(200);
		expect(await second.text()).toBe('{"run":1}');
		expect(second.headers.get("Vary")).toBe("Accept-Encoding, Cookie");
		expect(second.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
	});

	test("a public route varies on Accept-Encoding only", async () => {
		const publicResponse = await makeApp().handle(new Request("http://localhost/public"));

		expect(publicResponse.headers.get("Vary")).toBe("Accept-Encoding");
	});

	test("a cache hit carries the same Cache-Control, Vary and ETag as the miss", async () => {
		const app = new Elysia().use(responseCacheMiddleware).get("/headers", () => ({ data: "headers" }), {
			cache: { maxAge: 60, private: true },
		});
		const miss = await app.handle(new Request("http://localhost/headers"));
		const hit = await app.handle(new Request("http://localhost/headers"));

		const expectedHeaders = {
			"Cache-Control": "private, max-age=60",
			Vary: "Accept-Encoding, Cookie",
			ETag: '"d6afcbd8ff7a55df"',
		};
		expect(Object.fromEntries(Object.keys(expectedHeaders).map((name) => [name, miss.headers.get(name)]))).toEqual(expectedHeaders);
		expect(Object.fromEntries(Object.keys(expectedHeaders).map((name) => [name, hit.headers.get(name)]))).toEqual(expectedHeaders);
	});

	test("answers 304 when the validator matches the served ETag", async () => {
		const app = makeApp();
		const first = await app.handle(new Request("http://localhost/cached"));
		const etag = first.headers.get("ETag") as string;
		expect(etag).toMatch(ETAG_PATTERN);

		const response = await app.handle(new Request("http://localhost/cached", { headers: { "if-none-match": etag } }));

		expect(response.status).toBe(304);
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
