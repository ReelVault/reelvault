import { Elysia } from "elysia";
import { buildJsonResponse, jsonEtag } from "@/api/utils/etag.utils";
import { getResponseStatus, pathWithQuery } from "@/utils/http.utils";
import {
	type CachedResponseBody,
	getCachedResponseBody,
	RESPONSE_BODY_CACHE_MAX_BYTES,
	responseBodyCacheTtlMs,
	responseCacheKey,
	setCachedResponseBody,
} from "@/utils/response-body-cache";
import { isRecord } from "@/utils/type.utils";

interface CacheOptions {
	maxAge: number;
	private?: boolean | undefined;
	immutable?: boolean | undefined;
}

/**
 * Route-options helper for the standard response-cache + in-flight-dedup pair.
 * Use as `...cached({ maxAge: 60, private: true })` so routes opt in once.
 */
export function cached(options: CacheOptions) {
	return { cache: options, deduplicate: {} };
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

function cacheKeyFor(request: Request, resolvedProfileId?: string): string {
	return responseCacheKey({
		pathWithQuery: pathWithQuery(request.url),
		cookie: request.headers.get("cookie") ?? "",
		profileId: resolvedProfileId ?? request.headers.get("x-profile-id") ?? "",
		auth: request.headers.get("authorization") ?? "",
		// Machine keys are a distinct credential — without the segment two API
		// keys of different accounts would share the same cached private body.
		apiKey: request.headers.get("x-api-key") ?? "",
	});
}

/**
 * Materializes a cached JSON body into a Response through the shared JSON
 * response builder, memoizing the compressed variant on the cache entry so
 * repeat hits skip both serialization and compression.
 */
async function responseFromBody(request: Request, entry: CachedResponseBody, cacheControl: string, vary: string): Promise<Response> {
	return await buildJsonResponse({
		body: entry.body,
		etag: entry.etag,
		cacheControl,
		vary,
		acceptEncoding: request.headers.get("accept-encoding") ?? "",
		ifNoneMatch: request.headers.get("if-none-match"),
		encoded: entry.encoded,
	});
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
 * paths invalidate via invalidateResponseBodies(). Skips binary/streaming
 * Response returns to avoid false 304s.
 */
export const responseCacheMiddleware = new Elysia({ name: "ResponseCache" })
	.macro({
		cache: (options: CacheOptions) => {
			// Route options are fixed at registration — build the header strings once.
			const cacheControl = cacheControlFor(options);
			const vary = varyFor(options);

			return {
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

					set.headers["Cache-Control"] = cacheControl;
					set.headers.Vary = vary;

					if (context.responseValue instanceof Response) return undefined;

					const body = typeof context.responseValue === "string" ? context.responseValue : JSON.stringify(context.responseValue);
					if (isRecord(context.responseValue)) {
						serializedBodyCache.set(context.responseValue, body);
					}

					const etag = jsonEtag(body);
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
			};
		},
	})
	.as("global");
