import { hash as bunHash } from "bun";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { compressBuffer, negotiateEncoding } from "@/utils/compression.utils";
import { MemoryCache } from "@/utils/memory-cache";

interface CachedEtagBody {
	body: string;
}

/** Serialized JSON body plus per-encoding compressed variants, reused across requests. */
export interface CachedResponseBody {
	etag: string;
	body: string;
	expiresAt: number;
	encoded: Map<string, Uint8Array<ArrayBuffer>>;
}

/** Hard ceiling on a cacheable response body — oversized payloads are still served, just not cached. */
export const RESPONSE_BODY_CACHE_MAX_BYTES = 512 * 1024;
/** Server-side TTL cap regardless of the route's client-facing max-age. */
const RESPONSE_BODY_CACHE_MAX_TTL_MS = 5 * 60_000;

/**
 * Cross-request body cache for JSON GET routes. Serving a repeat request skips
 * the handler, response validation and serialization entirely; compression is
 * memoized per encoding. The TTL follows the route's declared client max-age
 * (bounded by RESPONSE_BODY_CACHE_MAX_TTL_MS), so server-side staleness never
 * exceeds what the browser cache contract already promises. Write paths
 * invalidate through clearEtagBodyCache().
 */
const responseBodyCache = new MemoryCache<CachedResponseBody>({
	// TTL is enforced per entry (expiresAt) so each route keeps its own max-age.
	ttlMs: -1,
	maxSize: systemResourcesService.getRamScaledCacheEntries(64, 128, 512),
	name: "api.responseBody",
});

export function responseBodyCacheTtlMs(maxAgeSeconds: number): number {
	return Math.min(maxAgeSeconds * 1000, RESPONSE_BODY_CACHE_MAX_TTL_MS);
}

export function getCachedResponseBody(key: string, now = Date.now()): CachedResponseBody | undefined {
	const entry = responseBodyCache.get(key);
	if (!entry) return undefined;

	if (entry.expiresAt <= now) {
		responseBodyCache.delete(key);

		return undefined;
	}

	return entry;
}

export function setCachedResponseBody(key: string, entry: CachedResponseBody): void {
	responseBodyCache.set(key, entry);
}

/**
 * Short-lived body+ETag cache for the heaviest aggregated endpoints. A 304
 * revalidation would otherwise re-run every aggregation query and re-serialize
 * the payload just to compute the hash. Staleness is bounded by the TTL
 * (user-state on detail pages may lag up to ttlMs; progress has its own
 * endpoint) and callers invalidate explicitly on writes via clearEtagBodyCache.
 */
const etagBodyCache = new MemoryCache<CachedEtagBody>({ ttlMs: 10_000, maxSize: 500, name: "api.etagBody" });

export function clearEtagBodyCache(): void {
	etagBodyCache.clear();
	responseBodyCache.clear();
}

/**
 * Drops cached bodies scoped to one profile without flushing the whole cache.
 * Cache keys embed the profile id (`...\0<path>\0<cookie>\0<profileId>\0<auth>`),
 * so per-profile writes (progress, watchlist, history) invalidate only the
 * affected identity instead of nuking every cached response.
 */
export function invalidateProfileResponseBodies(profileId: string): void {
	const needle = `\u0000${profileId}\u0000`;
	for (const key of responseBodyCache.keys()) {
		if (key.includes(needle)) responseBodyCache.delete(key);
	}

	for (const key of etagBodyCache.keys()) {
		if (key.includes(profileId)) etagBodyCache.delete(key);
	}
}

/**
 * JSON ETag/304 revalidation for profile-scoped GET responses.
 *
 * Returns a Response (200 JSON on miss, body-less 304 on a matching
 * If-None-Match, skipping serialization). Sets ETag + Vary: Cookie (per-profile
 * correctness) + private no-cache. The payload shape stays TS-checked at the
 * service boundary — Elysia response-schema validation does not apply to
 * pre-serialized Response returns, and the Response return type is required by
 * the composed handler typing of routes with global afterHandle plugins
 * (rate limiting).
 *
 * Compression happens HERE, not in the compression middleware: mapResponse
 * never sees these bodies (the handler returns a Response directly), and
 * returning a replacement Response from mapResponse is ignored when the
 * handler already returned one.
 *
 * Pass `cacheKey` for expensive aggregations to serve repeat requests from the
 * short-lived body cache (keyed per profile by the caller). Cached entries
 * store the UNCOMPRESSED body; the encoding is applied per response — do not
 * memoize compressed variants here: measured 2026-09-21, skipping the per-hit
 * compress lost the zlib threadpool pipelining and cost ~8.5% req/s at c=50
 * despite winning ~17% at c=10.
 */
export async function withEtagResponse<T>(
	request: Request,
	set: { headers: Record<string, unknown> },
	load: () => Promise<T>,
	options?: { cacheKey?: string },
): Promise<Response> {
	const ifNoneMatch = request.headers.get("if-none-match");
	const encoding = negotiateEncoding(request.headers.get("accept-encoding") ?? "");
	const minSize = serverConfig.compression.minSizeBytes;

	const buildResponse = async (body: string): Promise<Response> => {
		// bunHash, same as response-cache — ETags here are only revalidation hints
		// for the uncompressed representation, and SHA-256 cost 3-5x more.
		const etag = `"${bunHash(body).toString(16)}"`;
		const baseHeaders: Record<string, string> = {
			ETag: etag,
			Vary: "Cookie, Accept-Encoding",
			"Cache-Control": "private, no-cache",
		};
		set.headers.ETag = etag;
		set.headers.Vary = baseHeaders.Vary;
		set.headers["Cache-Control"] = baseHeaders["Cache-Control"];

		if (ifNoneMatch === etag) {
			return new Response(null, { status: 304, headers: baseHeaders });
		}

		if (encoding && body.length >= minSize) {
			const compressed = await compressBuffer(Buffer.from(body), encoding);

			return new Response(Uint8Array.from(compressed), {
				status: 200,
				headers: { ...baseHeaders, "Content-Type": "application/json", "Content-Encoding": encoding },
			});
		}

		return new Response(body, { status: 200, headers: { ...baseHeaders, "Content-Type": "application/json" } });
	};

	if (options?.cacheKey) {
		const cached = etagBodyCache.get(options.cacheKey);
		if (cached) return await buildResponse(cached.body);
	}

	// Load lazily: a body-cache hit must not run the aggregation at all.
	const resolved = await load();
	const body = JSON.stringify(resolved);

	// Oversized payloads are still served, just not cached (same guard as
	// responseBodyCache — in-memory caches must stay bounded in bytes, not only
	// in entries).
	if (options?.cacheKey && body.length <= RESPONSE_BODY_CACHE_MAX_BYTES) {
		etagBodyCache.set(options.cacheKey, { body });
	}

	return await buildResponse(body);
}
