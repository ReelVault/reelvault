import { systemResourcesService } from "@/system/system-resources.service";
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
 * invalidate through invalidateResponseBodies()/invalidateProfileResponseBodies().
 */
const responseBodyCache = new MemoryCache<CachedResponseBody>({
	// TTL is enforced per entry (expiresAt) so each route keeps its own max-age.
	ttlMs: -1,
	maxSize: systemResourcesService.getRamScaledCacheEntries(64, 128, 512),
	name: "api.responseBody",
});

/** NUL never appears in URLs or HTTP headers, so it is safe as a key segment separator. */
const KEY_SEGMENT_SEPARATOR = "\u0000";

/**
 * Path+query+identity key. The cookie (session) and resolved profile id make
 * the key per-identity, so per-profile payloads never leak between
 * users/profiles and per-profile writes can invalidate precisely.
 */
export function responseCacheKey(parts: { pathWithQuery: string; cookie: string; profileId: string; auth: string }): string {
	return [parts.pathWithQuery, parts.cookie, parts.profileId, parts.auth].join(KEY_SEGMENT_SEPARATOR);
}

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
 * endpoint) and callers invalidate explicitly on writes.
 */
const etagBodyCache = new MemoryCache<CachedEtagBody>({ ttlMs: 10_000, maxSize: 500, name: "api.etagBody" });

/** Flushes both response body caches after any write that can stale arbitrary cached GETs. */
export function invalidateResponseBodies(): void {
	etagBodyCache.clear();
	responseBodyCache.clear();
}

/**
 * Drops cached bodies scoped to one profile without flushing the whole cache.
 * Response-cache keys embed the profile id as their own segment, and ETag-body
 * cache keys embed it after a colon, so per-profile writes (progress,
 * watchlist, history) invalidate only the affected identity instead of nuking
 * every cached response.
 */
export function invalidateProfileResponseBodies(profileId: string): void {
	const needle = `${KEY_SEGMENT_SEPARATOR}${profileId}${KEY_SEGMENT_SEPARATOR}`;
	for (const key of responseBodyCache.keys()) {
		if (key.includes(needle)) responseBodyCache.delete(key);
	}

	for (const key of etagBodyCache.keys()) {
		if (key.includes(profileId)) etagBodyCache.delete(key);
	}
}

export function getCachedEtagBody(key: string): string | undefined {
	return etagBodyCache.get(key)?.body;
}

/** Caches an uncompressed aggregation body unless it exceeds RESPONSE_BODY_CACHE_MAX_BYTES. */
export function cacheEtagBody(key: string, body: string): void {
	if (body.length > RESPONSE_BODY_CACHE_MAX_BYTES) return;

	etagBodyCache.set(key, { body });
}
