import { expect, test } from "bun:test";
import { gunzipSync, inflateSync } from "node:zlib";
import Elysia from "elysia";
import { compressionMiddleware } from "./compression.middleware";

test("compresses large JSON responses with gzip/br", async () => {
	const app = new Elysia()
		.use(compressionMiddleware)
		.get("/large-json", () => ({ items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `Item ${i}` })) }));

	const res = await app.handle(
		new Request("http://localhost/large-json", {
			headers: { "accept-encoding": "gzip, deflate, br" },
		}),
	);

	expect(res.status).toBe(200);
	expect(res.headers.get("content-encoding")).toBe("br");
	expect(res.headers.get("vary")).toBe("Accept-Encoding");
	expect(res.headers.get("content-type")).toContain("application/json");

	const arrayBuffer = await res.arrayBuffer();
	expect(arrayBuffer.byteLength).toBeGreaterThan(0);
});

test("compresses large text responses with gzip when br is not accepted", async () => {
	const longText = "ReelVault Media Server ".repeat(100);
	const app = new Elysia().use(compressionMiddleware).get("/large-text", () => longText);

	const res = await app.handle(
		new Request("http://localhost/large-text", {
			headers: { "accept-encoding": "gzip, deflate" },
		}),
	);

	expect(res.status).toBe(200);
	expect(res.headers.get("content-encoding")).toBe("gzip");
	const arrayBuffer = await res.arrayBuffer();
	const decompressed = gunzipSync(Buffer.from(arrayBuffer)).toString("utf-8");
	expect(decompressed).toBe(longText);
});

test("compresses large responses with deflate when only deflate is accepted", async () => {
	const longText = "ReelVault Media Server ".repeat(100);
	const app = new Elysia().use(compressionMiddleware).get("/large-text", () => longText);

	const res = await app.handle(
		new Request("http://localhost/large-text", {
			headers: { "accept-encoding": "deflate" },
		}),
	);

	expect(res.status).toBe(200);
	expect(res.headers.get("content-encoding")).toBe("deflate");
	const arrayBuffer = await res.arrayBuffer();
	const decompressed = inflateSync(Buffer.from(arrayBuffer)).toString("utf-8");
	expect(decompressed).toBe(longText);
});

test("skips responses smaller than minSizeBytes threshold", async () => {
	const app = new Elysia().use(compressionMiddleware).get("/small", () => ({ status: "ok" }));

	const res = await app.handle(
		new Request("http://localhost/small", {
			headers: { "accept-encoding": "gzip, br" },
		}),
	);

	expect(res.status).toBe(200);
	expect(res.headers.get("content-encoding")).toBeNull();
	const body = await res.json();
	expect(body).toEqual({ status: "ok" });
});

test("skips responses when client sends no accept-encoding header", async () => {
	const app = new Elysia()
		.use(compressionMiddleware)
		.get("/large-json", () => ({ items: Array.from({ length: 100 }, (_, i) => ({ id: i })) }));

	const res = await app.handle(new Request("http://localhost/large-json"));

	expect(res.status).toBe(200);
	expect(res.headers.get("content-encoding")).toBeNull();
});
