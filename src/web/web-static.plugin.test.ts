import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { env } from "@/env";
import { webStaticPlugin } from "./web-static.plugin";

let webRoot: string | undefined;

function seedWebRoot(): string {
	webRoot = mkdtempSync(join(tmpdir(), "reelvault-web-"));
	mkdirSync(join(webRoot, "assets"));
	writeFileSync(join(webRoot, "index.html"), "<!doctype html><html><head><title>ReelVault</title></head><body>ReelVault SPA</body></html>");
	writeFileSync(join(webRoot, "assets", "app-Q1W2E3.js"), "console.log('app');");
	writeFileSync(join(webRoot, "favicon.ico"), "ico");
	// Stable mtimes → stable ETag assertions across the test run.
	utimesSync(join(webRoot, "index.html"), new Date(0), new Date(0));

	return webRoot;
}

function testApp() {
	return new Elysia().get("/v1/health", () => ({ ok: true })).use(webStaticPlugin);
}

async function get(path: string, headers?: Record<string, string>): Promise<Response> {
	const init: RequestInit = headers ? { headers } : {};

	return await testApp().handle(new Request(`http://localhost${path}`, init));
}

afterEach(() => {
	if (webRoot) {
		rmSync(webRoot, { recursive: true, force: true });
		webRoot = undefined;
	}

	env.APP_WEB_DIST = undefined;
});

describe("webStaticPlugin", () => {
	test("serves index.html at the root with no-cache", async () => {
		env.APP_WEB_DIST = seedWebRoot();

		const response = await get("/");

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/html");
		expect(response.headers.get("Cache-Control")).toBe("no-cache");
		expect(await response.text()).toContain("ReelVault SPA");
	});

	test("falls back to index.html for extension-less routes", async () => {
		env.APP_WEB_DIST = seedWebRoot();

		const response = await get("/setup");

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/html");
		expect(await response.text()).toContain("ReelVault SPA");
	});

	test("injects the same-origin API marker into the app entry only", async () => {
		env.APP_WEB_DIST = seedWebRoot();

		const entry = await get("/");
		expect(await entry.text()).toContain('meta name="reelvault-api-origin" content="same-origin"');

		const fallback = await get("/setup");
		expect(await fallback.text()).toContain('meta name="reelvault-api-origin" content="same-origin"');

		const asset = await get("/assets/app-Q1W2E3.js");
		expect(await asset.text()).toBe("console.log('app');");
	});

	test("serves hashed assets with immutable caching", async () => {
		env.APP_WEB_DIST = seedWebRoot();

		const response = await get("/assets/app-Q1W2E3.js");

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
		expect(response.headers.get("ETag")).toBeString();
		expect(await response.text()).toContain("console.log");
	});

	test("answers 304 for a matching If-None-Match", async () => {
		env.APP_WEB_DIST = seedWebRoot();

		const first = await get("/");
		const etag = first.headers.get("ETag");
		expect(etag).toBeString();

		const second = await get("/", { "If-None-Match": etag ?? "" });

		expect(second.status).toBe(304);
		expect(await second.text()).toBe("");
	});

	test("returns 404 for missing files with an extension", async () => {
		env.APP_WEB_DIST = seedWebRoot();

		const response = await get("/assets/missing.js");

		expect(response.status).toBe(404);
	});

	test("blocks path traversal outside the web root", async () => {
		const root = seedWebRoot();
		env.APP_WEB_DIST = root;
		writeFileSync(join(root, "..", "secret.txt"), "top secret");

		const response = await get("/..%2fsecret.txt");

		expect(response.status).toBe(404);
	});

	test("keeps explicit /v1 routes ahead of the wildcard", async () => {
		env.APP_WEB_DIST = seedWebRoot();

		const response = await get("/v1/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	test("unknown API paths still yield the API 404 shape", async () => {
		env.APP_WEB_DIST = seedWebRoot();

		const response = await get("/v1/does-not-exist");

		expect(response.status).toBe(404);
	});

	test("stays API-only when no web dist exists", async () => {
		env.APP_WEB_DIST = join(tmpdir(), `reelvault-missing-${process.pid}`);

		expect((await get("/")).status).toBe(404);
		expect((await get("/setup")).status).toBe(404);
	});
});
