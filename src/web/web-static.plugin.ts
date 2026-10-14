import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { file as bunFile } from "bun";
import { Elysia } from "elysia";
import { NotFoundError } from "elysia/error";
import { apiRouter } from "@/api/routes";
import { isWebApiPath } from "@/api/utils/route-classification.utils";
import { getPathname, matchesIfNoneMatch } from "@/utils/http.utils";
import { byteRangeResponse } from "@/utils/http-range.utils";
import { PathUtils } from "@/utils/path.utils";
import { resolveWebDistRoot } from "./web-dist";

const CONTENT_TYPES: Record<string, string> = {
	".avif": "image/avif",
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".htm": "text/html; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json",
	".map": "application/json",
	".mjs": "text/javascript; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".wasm": "application/wasm",
	".webmanifest": "application/manifest+json",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

const HTML_ENTRY = "index.html";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const ASSETS_PREFIX = "assets/";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const HTML_CACHE_CONTROL = "no-cache";
const STATIC_CACHE_CONTROL = "public, max-age=3600";
const HEAD_TAG = "<head>";

/**
 * Injected into the served index.html so the web client can detect
 * single-port hosting synchronously and target the API on this same origin —
 * the api.*-subdomain / port-3030 heuristics would miss reverse-proxy setups.
 */
const API_ORIGIN_META_TAG = '<meta name="reelvault-api-origin" content="same-origin">';

let indexEntryCache: { key: string; body: Buffer } | undefined;

/** Stat fields the handler needs; plain data so `assets/` entries can be cached. */
interface FileStatView {
	mtimeMs: number;
	size: number;
	isFile: boolean;
}

function toFileStatView(fileStat: Stats | null): FileStatView | null {
	if (!fileStat) return null;

	return { mtimeMs: fileStat.mtimeMs, size: fileStat.size, isFile: fileStat.isFile() };
}

/**
 * Stats for immutable `assets/` files, keyed by path. Names are content-hashed
 * and served `immutable`, so a cached entry never goes stale in place; the cap
 * only bounds a long-lived process.
 */
const ASSET_STAT_CACHE_MAX_ENTRIES = 512;
const assetStatCache = new Map<string, FileStatView>();

function rememberAssetStat(filePath: string, fileStat: FileStatView): void {
	if (assetStatCache.size >= ASSET_STAT_CACHE_MAX_ENTRIES) {
		const oldest = assetStatCache.keys().next().value;
		if (oldest !== undefined) assetStatCache.delete(oldest);
	}

	assetStatCache.set(filePath, fileStat);
}

async function statIndexEntry(root: string): Promise<FileStatView | null> {
	return toFileStatView(await stat(join(root, HTML_ENTRY)).catch(() => null));
}

/**
 * Stat for the requested path, plus whether it is the app entry. `/` and
 * `/index.html` resolve straight to index.html; `assets/` stats come from the
 * immutable-path cache; everything else stats the file. Null when missing.
 */
async function resolveEntryStat(
	root: string,
	relativePath: string,
	filePath: string,
): Promise<{ isHtmlEntry: boolean; fileStat: FileStatView | null }> {
	if (relativePath.length === 0 || relativePath === HTML_ENTRY) {
		return { isHtmlEntry: true, fileStat: await statIndexEntry(root) };
	}

	if (relativePath.startsWith(ASSETS_PREFIX)) {
		const cached = assetStatCache.get(filePath);
		if (cached) return { isHtmlEntry: false, fileStat: cached };

		const fileStat = toFileStatView(await stat(filePath).catch(() => null));
		if (fileStat?.isFile) rememberAssetStat(filePath, fileStat);

		return { isHtmlEntry: false, fileStat };
	}

	return { isHtmlEntry: false, fileStat: toFileStatView(await stat(filePath).catch(() => null)) };
}

async function loadIndexEntry(root: string, fileStat: FileStatView): Promise<Buffer> {
	const filePath = join(root, HTML_ENTRY);
	const key = `${root}-${fileStat.mtimeMs}-${fileStat.size}`;
	if (indexEntryCache?.key !== key) {
		const raw = await readFile(filePath, "utf8");
		const headIndex = raw.indexOf(HEAD_TAG);
		const body =
			headIndex >= 0 ? `${raw.slice(0, headIndex + HEAD_TAG.length)}${API_ORIGIN_META_TAG}${raw.slice(headIndex + HEAD_TAG.length)}` : raw;
		indexEntryCache = { key, body: Buffer.from(body) };
	}

	return indexEntryCache.body;
}

function contentTypeFor(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	if (dot < 0) return "application/octet-stream";

	return CONTENT_TYPES[filePath.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

function notFoundResponse(): Response {
	return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function cacheControlFor(isHtmlEntry: boolean, relativePath: string) {
	if (isHtmlEntry) return HTML_CACHE_CONTROL;
	if (relativePath.startsWith(ASSETS_PREFIX)) return IMMUTABLE_CACHE_CONTROL;

	return STATIC_CACHE_CONTROL;
}

/**
 * Serves the bundled web UI (SPA) when a web dist is present — APP_WEB_DIST or
 * `./web`. Mounted after the API router: the wildcard only catches paths the
 * API surface did not, and API paths rethrow NOT_FOUND so unknown /v1 & /openapi
 * routes keep their JSON 404 envelope.
 */
export const webStaticPlugin = new Elysia({ name: "WebStatic" }).get("/*", async ({ request, set }) => {
	// The root wildcard outranks the API's own parameter+wildcard routes for GET,
	// so unknown-looking /v1 paths would never reach their handlers. Re-run the
	// API router for those paths; a real API response wins, a 404 keeps the JSON
	// envelope this fallback exists to provide.
	if (isWebApiPath(getPathname(request.url))) {
		const apiResponse = await apiRouter.handle(request);
		if (apiResponse.status !== 404) return apiResponse;

		throw new NotFoundError();
	}

	const root = resolveWebDistRoot();
	if (!root) throw new NotFoundError();

	const segments: string[] = [];
	for (const rawSegment of new URL(request.url).pathname.split("/")) {
		if (rawSegment.length === 0) continue;

		let decoded: string;
		try {
			decoded = decodeURIComponent(rawSegment);
		} catch {
			return notFoundResponse();
		}

		if (decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
			return notFoundResponse();
		}

		segments.push(decoded);
	}

	const relativePath = segments.join("/");
	// Only KNOWN servable extensions mark a path as a file request. Plugin ids
	// contain dots ("org.example.app"), so testing for any ".suffix" would turn
	// their SPA routes into 404s before the fallback could serve index.html.
	const hasFileExtension = Object.hasOwn(CONTENT_TYPES, PathUtils.getExtension(relativePath).toLowerCase());
	const filePath = join(root, ...segments);
	// A direct `/index.html` request (the PWA precache, curious users) must get the
	// same transformed entry as the SPA fallback — without the injected API-origin
	// marker the service worker would pin an app shell that targets the wrong API
	// origin, and without no-cache browsers keep a stale shell for an hour.
	const direct = await resolveEntryStat(root, relativePath, filePath);
	let isHtmlEntry = direct.isHtmlEntry;
	let entryStat = direct.fileStat;

	if (!entryStat?.isFile) {
		if (hasFileExtension) return notFoundResponse();

		// SPA fallback: extension-less routes resolve to the app entry.
		isHtmlEntry = true;
		entryStat = await statIndexEntry(root);
		if (!entryStat?.isFile) return notFoundResponse();
	}

	const etag = `W/"${Math.floor(entryStat.mtimeMs)}-${entryStat.size}"`;
	const cacheControl = cacheControlFor(isHtmlEntry, relativePath);

	if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
		set.status = 304;
		// A 304 must repeat the validating headers (and keep the HTML entry's type).
		set.headers["Cache-Control"] = cacheControl;
		set.headers.ETag = etag;
		if (isHtmlEntry) set.headers["Content-Type"] = HTML_CONTENT_TYPE;

		return "";
	}

	// The HTML entry stays an in-memory buffer: it is meta-tag-transformed and
	// hot. Real files stream through Bun's minimal-copy file handle instead of
	// being read whole into the heap, with single-range support for resumable /
	// seeking clients. Returning a Response bypasses `set.headers`, so the full
	// header set travels on the Response itself.
	if (isHtmlEntry) {
		set.headers["Content-Type"] = HTML_CONTENT_TYPE;
		set.headers["Cache-Control"] = cacheControl;
		set.headers.ETag = etag;

		return await loadIndexEntry(root, entryStat);
	}

	const headers: Record<string, string> = {
		"Content-Type": contentTypeFor(filePath),
		"Cache-Control": cacheControl,
		ETag: etag,
		"Accept-Ranges": "bytes",
	};

	const handle = bunFile(filePath);
	const ranged = byteRangeResponse(handle, request.headers.get("range"), headers);
	if (ranged) return ranged;

	return new Response(handle, { status: 200, headers });
});
