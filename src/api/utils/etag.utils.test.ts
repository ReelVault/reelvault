import { describe, expect, test } from "bun:test";
import { brotliDecompressSync } from "node:zlib";
import { clearEtagBodyCache, withEtagResponse } from "./etag.utils";

const etagPattern = /^"[0-9a-f]+"$/;

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request("http://localhost/v1/example", { headers });
}

const setHeaders = (): { headers: Record<string, unknown> } => ({ headers: {} });

describe("withEtagResponse", () => {
	test("returns 200 JSON with etag, Vary and private no-cache headers", async () => {
		clearEtagBodyCache();
		const set = setHeaders();
		const response = await withEtagResponse(makeRequest(), set, () => Promise.resolve({ hello: "world" }));

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("application/json");
		expect(response.headers.get("Vary")).toBe("Cookie, Accept-Encoding");
		expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
		expect(response.headers.get("ETag")).toMatch(etagPattern);
		expect(set.headers.ETag).toBe(response.headers.get("ETag"));
		expect(await response.text()).toBe(JSON.stringify({ hello: "world" }));
	});

	test("answers 304 with an empty body when If-None-Match matches the current payload", async () => {
		clearEtagBodyCache();
		const set = setHeaders();
		const first = await withEtagResponse(makeRequest(), set, () => Promise.resolve({ a: 1 }));
		const etag = first.headers.get("ETag") as string;

		const second = await withEtagResponse(makeRequest({ "if-none-match": etag }), setHeaders(), () => Promise.resolve({ a: 1 }));

		expect(second.status).toBe(304);
		expect(second.headers.get("ETag")).toBe(etag);
	});

	test("different payloads produce different etags", async () => {
		clearEtagBodyCache();
		const etagOf = async (payload: object) =>
			(await withEtagResponse(makeRequest(), setHeaders(), () => Promise.resolve(payload))).headers.get("ETag");

		expect(await etagOf({ a: 1 })).not.toBe(await etagOf({ a: 2 }));
	});

	test("serves repeat requests from the body cache within the TTL", async () => {
		clearEtagBodyCache();
		let run = 0;
		const options = { cacheKey: "profile-1:discover" };

		const first = await withEtagResponse(makeRequest(), setHeaders(), () => Promise.resolve({ run: ++run }), options);
		// Even though the producer would now return fresh data, the cached body is served.
		const second = await withEtagResponse(makeRequest(), setHeaders(), () => Promise.resolve({ run: ++run }), options);

		const firstBody = await first.text();
		const secondBody = await second.text();

		expect(second.status).toBe(first.status);
		expect(secondBody).toBe(firstBody);
		expect(JSON.parse(secondBody)).toEqual({ run: 1 });
		// The loader is lazy: a cache hit must not run the aggregation at all.
		expect(run).toBe(1);
	});

	test("compressed responses carry Content-Encoding for large payloads", async () => {
		clearEtagBodyCache();
		const bigPayload = { text: "reelvault".repeat(400) };
		const response = await withEtagResponse(makeRequest({ "accept-encoding": "br" }), setHeaders(), () => Promise.resolve(bigPayload));

		expect(response.headers.get("Content-Encoding")).toBe("br");
		expect(response.headers.get("Content-Type")).toBe("application/json");
	});

	test("cache hit keeps serving the compressed encoding for repeat requests", async () => {
		clearEtagBodyCache();
		let run = 0;
		const payload = () => ({ text: "reelvault".repeat(400), run: ++run });
		const options = { cacheKey: "profile-1:big" };

		const first = await withEtagResponse(makeRequest({ "accept-encoding": "br" }), setHeaders(), () => Promise.resolve(payload()), options);
		const second = await withEtagResponse(
			makeRequest({ "accept-encoding": "br" }),
			setHeaders(),
			() => Promise.resolve(payload()),
			options,
		);

		expect(run).toBe(1);
		expect(second.headers.get("ETag")).toBe(first.headers.get("ETag"));
		expect(second.headers.get("Content-Encoding")).toBe("br");

		const firstBody = brotliDecompressSync(new Uint8Array(await first.arrayBuffer()));
		const secondBody = brotliDecompressSync(new Uint8Array(await second.arrayBuffer()));
		expect(JSON.parse(secondBody.toString())).toEqual(JSON.parse(firstBody.toString()));
	});

	test("304 revalidation works off the cache without running the loader", async () => {
		clearEtagBodyCache();
		let run = 0;
		const options = { cacheKey: "profile-1:revalidate" };

		const first = await withEtagResponse(makeRequest(), setHeaders(), () => Promise.resolve({ run: ++run }), options);
		const etag = first.headers.get("ETag") as string;
		const second = await withEtagResponse(
			makeRequest({ "if-none-match": etag }),
			setHeaders(),
			() => Promise.resolve({ run: ++run }),
			options,
		);

		expect(run).toBe(1);
		expect(second.status).toBe(304);
		expect(second.headers.get("ETag")).toBe(etag);
	});

	test("oversized payloads are served but not cached", async () => {
		clearEtagBodyCache();
		let run = 0;
		const options = { cacheKey: "profile-1:huge" };

		const first = await withEtagResponse(
			makeRequest(),
			setHeaders(),
			() => Promise.resolve({ text: "x".repeat(600_000), run: ++run }),
			options,
		);
		const second = await withEtagResponse(
			makeRequest(),
			setHeaders(),
			() => Promise.resolve({ text: "x".repeat(600_000), run: ++run }),
			options,
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		// Not cached: the second call had to run the loader again.
		expect(run).toBe(2);
	});
});
