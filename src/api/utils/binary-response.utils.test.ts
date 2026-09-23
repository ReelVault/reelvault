import { describe, expect, test } from "bun:test";
import { binaryFileResponse } from "./binary-response.utils";

function file(size: number, lastModified = 1_700_000_000_000): File {
	const body = new Uint8Array(size);

	return new File([body], "poster.jpg", { type: "image/webp", lastModified });
}

const CACHE_CONTROL = "public, max-age=3600";
const ETAG = `"1234-1700000000000"`;

describe("binaryFileResponse", () => {
	test("returns 200 with the etag, content type and cache headers", async () => {
		const response = binaryFileResponse(file(1_234), "image/webp", CACHE_CONTROL, null);

		expect(response.status).toBe(200);
		expect(response.headers.get("ETag")).toBe(ETAG);
		expect(response.headers.get("Content-Type")).toBe("image/webp");
		expect(response.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
		expect(response.headers.get("Vary")).toBe("Accept-Encoding");
		expect((await response.arrayBuffer()).byteLength).toBe(1_234);
	});

	test("answers 304 with an empty body when If-None-Match matches", async () => {
		const response = binaryFileResponse(file(1_234), "image/webp", CACHE_CONTROL, ETAG);

		expect(response.status).toBe(304);
		expect(response.headers.get("ETag")).toBe(ETAG);
		expect((await response.arrayBuffer()).byteLength).toBe(0);
	});

	test("accepts weak validators and comma-separated candidate lists", () => {
		expect(binaryFileResponse(file(1_234), "image/webp", CACHE_CONTROL, `W/${ETAG}`).status).toBe(304);
		expect(binaryFileResponse(file(1_234), "image/webp", CACHE_CONTROL, `"stale", ${ETAG}`).status).toBe(304);
		expect(binaryFileResponse(file(1_234), "image/webp", CACHE_CONTROL, `W/${ETAG}, "other"`).status).toBe(304);
	});

	test("returns 200 when the validator does not match", () => {
		expect(binaryFileResponse(file(1_234), "image/webp", CACHE_CONTROL, `"999-1"`).status).toBe(200);
	});

	test("omits the etag for empty files and never 304s them", () => {
		const response = binaryFileResponse(file(0), "image/webp", CACHE_CONTROL, ETAG);
		expect(response.status).toBe(200);
		expect(response.headers.get("ETag")).toBe(null);
	});
});
