import { hash as bunHash } from "bun";
import { Elysia } from "elysia";
import {
	type CachedResponseBody,
	getCachedResponseBody,
	RESPONSE_BODY_CACHE_MAX_BYTES,
	responseBodyCacheTtlMs,
	setCachedResponseBody,
} from "@/api/utils/etag.utils";
import { serverConfig } from "@/server.config";
import { compressBuffer, negotiateEncoding } from "@/utils/compression.utils";
import { getResponseStatus } from "@/utils/http.utils";
import { isRecord } from "@/utils/type.utils";

interface CacheOptions {
	maxAge: number;
	private?: boolean | undefined;
	immutable?: boolean | undefined;
}

/**
 * Shares the JSON serialization of a response body between the response-cache
 * (ETag) and compression middlewares, so large cached JSON bodies are
 * serialized only once per request.
 */
export const serializedBodyCache = new WeakMap<object, string>();

function cacheControlFor(options: CacheOptions): string {
	return `${options.private ? "private" : "public"}, max-age=${options.maxAge}${options.immutable ? ", immutable" : ""}`;
}

function varyFor(options: CacheOptions): "Accept-Encoding, Cookie" | "Accept-Encoding" {
	// Private responses key off the session cookie — without Vary two profiles in
	// one browser would share the cached copy.
	return options.private ? "Accept-Encoding, Cookie" : "Accept-Encoding";
}

/**
 * Reads the resolved active profile id off the macro context. The auth
 * middleware derives `profile` globally, so this is present on guarded routes;
 * unguarded routes fall back to the `x-profile-id` header (or an empty segment).
 */
function resolveProfileId(context: object): string | undefined {
	if (!("profile" in context)) return undefined;

	const profile: unknown = context.profile;
	if (typeof profile !== "object" || profile === null || !("id" in profile)) return undefined;

	const id: unknown = profile.id;

	return typeof id === "string" ? id : undefined;
}

/**
 * Path+query+identity key. The cookie (session) and resolved profile id make
 * the key per-identity, so per-profile payloads never leak between
 * users/profiles and per-profile writes can invalidate precisely.
 */
function cacheKeyFor(request: Request, resolvedProfileId?: string): string {
	const rawUrl = request.url;
	const pathStart = rawUrl.indexOf("/", rawUrl.indexOf("//") + 2);
	const pathWithQuery = pathStart === -1 ? rawUrl : rawUrl.slice(pathStart);
	const cookie = request.headers.get("cookie") ?? "";
	const profileId = resolvedProfileId ?? request.headers.get("x-profile-id") ?? "";
	const auth = request.headers.get("authorization") ?? "";

	return `${pathWithQuery}\u0000${cookie}\u0000${profileId}\u0000${auth}`;
}

/**
 * Materializes a cached JSON body into a Response, negotiating compression and
 * memoizing the compressed variant on the cache entry so repeat hits skip both
 * serialization and compression.
 */
async function responseFromBody(request: Request, entry: CachedResponseBody, cacheControl: string, vary: string): Promise<Response> {
	const headers = new Headers({
		ETag: entry.etag,
		Vary: vary,
		"Cache-Control": cacheControl,
		"Content-Type": "application/json; charset=utf-8",
	});

	if (request.headers.get("if-none-match") === entry.etag) {
		return new Response(null, { status: 304, headers });
	}

	const encoding = negotiateEncoding(request.headers.get("accept-encoding") ?? "");
	if (encoding && entry.body.length >= serverConfig.compression.minSizeBytes) {
		let compressed = entry.encoded.get(encoding);
		if (!compressed) {
			compressed = Uint8Array.from(await compressBuffer(Buffer.from(entry.body), encoding));
			entry.encoded.set(encoding, compressed);
		}

		headers.set("Content-Encoding", encoding);

		return new Response(compressed, { status: 200, headers });
	}

	return new Response(entry.body, { status: 200, headers });
}

/**
 * Response Cache Middleware.
 * Adds Cache-Control, ETag and 304 Not Modified support.
 *
 * Usage:
 *   .get("/movies", handler, { cache: { maxAge: 60 } })
 *
 * Opt-in per route. On a hit the handler is skipped entirely and the cached
 * body is served (no response-schema validation, no re-serialization). Write
 * paths invalidate via clearEtagBodyCache(). Skips binary/streaming Response
 * returns to avoid false 304s.
 */
export const responseCacheMiddleware = new Elysia({ name: "ResponseCache" })
	.macro({
		cache: (options: CacheOptions) => ({
			async beforeHandle(context): Promise<Response | undefined> {
				const { request, set } = context;
				if (request.method !== "GET") return undefined;

				// A session that resolved to no user (revoked/expired) must never be
				// served a cached private body — read through to the auth-guarded
				// handler, which rejects it.
				if ("user" in context && context.user === null) return undefined;

				// Standard HTTP revalidation request: read through to the handler
				// (the fresh body may still yield a 304 via its freshly computed ETag).
				if (request.headers.get("cache-control")?.includes("no-cache")) return undefined;

				const entry = getCachedResponseBody(cacheKeyFor(request, resolveProfileId(context)));
				if (!entry) return undefined;

				const cacheControl = cacheControlFor(options);
				const vary = varyFor(options);
				set.headers["Cache-Control"] = cacheControl;
				set.headers.Vary = vary;
				set.headers.ETag = entry.etag;

				return await responseFromBody(request, entry, cacheControl, vary);
			},
			async afterHandle(context): Promise<Response | undefined> {
				const { set, request } = context;
				const status = getResponseStatus(set);
				if (status !== 200) return undefined;

				if (request.method !== "GET") return undefined;

				const cacheControl = cacheControlFor(options);
				const vary = varyFor(options);
				set.headers["Cache-Control"] = cacheControl;
				set.headers.Vary = vary;

				if (context.responseValue instanceof Response) return undefined;

				const body = typeof context.responseValue === "string" ? context.responseValue : JSON.stringify(context.responseValue);
				if (isRecord(context.responseValue)) {
					serializedBodyCache.set(context.responseValue, body);
				}

				const etag = `"${bunHash(body).toString(16)}"`;
				set.headers.ETag = etag;

				const entry: CachedResponseBody = {
					etag,
					body,
					expiresAt: Date.now() + responseBodyCacheTtlMs(options.maxAge),
					encoded: new Map(),
				};

				if (body.length <= RESPONSE_BODY_CACHE_MAX_BYTES) {
					setCachedResponseBody(cacheKeyFor(request, resolveProfileId(context)), entry);
				}

				return await responseFromBody(request, entry, cacheControl, vary);
			},
		}),
	})
	.as("global");
