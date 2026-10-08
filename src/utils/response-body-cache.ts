import { systemResourcesService } from "@/system/system-resources.service";
import { MemoryCache } from "@/utils/memory-cache";

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
/** TTL of the short-lived aggregation bodies stored by withEtagResponse(). */
const ETAG_BODY_CACHE_TTL_MS = 10_000;

/**
 * Cross-request body cache shared by the response-cache middleware (route-level
 * `cache` macro) and withEtagResponse() aggregations. Serving a repeat request
 * skips the handler, response validation and serialization entirely; the
 * response-cache middleware also memoizes compression per encoding. The TTL
 * follows the route's declared client max-age (bounded by
 * RESPONSE_BODY_CACHE_MAX_TTL_MS) or ETAG_BODY_CACHE_TTL_MS for etag bodies.
 * Write paths invalidate through invalidateResponseBodies()/
 * invalidateProfileResponseBodies().
 */
/** NUL never appears in URLs or HTTP headers, so it is safe as a key segment separator. */
const KEY_SEGMENT_SEPARATOR = "\u0000";

/**
 * profileId → cached keys. invalidateProfileResponseBodies() runs on EVERY
 * progress/watchlist write (each stream heartbeat), so invalidation must be a
 * Set lookup, not a full cache scan.
 */
const profileKeyIndex = new Map<string, Set<string>>();

/**
 * Keys of withEtagResponse() entries. Their cache keys embed the profile id as
 * the last colon-separated segment, so per-profile invalidation scans this
 * short-lived subset instead of the whole cache.
 */
const etagBodyKeys = new Set<string>();

function removeFromProfileIndex(key: string): void {
	const profileId = key.split(KEY_SEGMENT_SEPARATOR)[2];
	if (!profileId) return;

	const keys = profileKeyIndex.get(profileId);
	if (!keys) return;

	keys.delete(key);
	if (keys.size === 0) profileKeyIndex.delete(profileId);
}

const responseBodyCache = new MemoryCache<CachedResponseBody>({
	// TTL is enforced per entry (expiresAt) so each route keeps its own max-age.
	ttlMs: -1,
	maxSize: systemResourcesService.getRamScaledCacheEntries(64, 128, 512),
	name: "api.responseBody",
	// Keep the per-profile and etag-key indexes honest across LRU evictions.
	onEvict: (key) => {
		removeFromProfileIndex(key);
		etagBodyKeys.delete(key);
	},
});

/**
 * Path+query+identity key. The cookie (session), resolved profile id and
 * `x-api-key` make the key per-identity, so per-user payloads never leak
 * between sessions, profiles or machine API keys, and per-profile writes can
 * invalidate precisely. The profile id stays the third segment — the profile
 * index parses it by position.
 */
export function responseCacheKey(parts: {
	pathWithQuery: string;
	cookie: string;
	profileId: string;
	auth: string;
	apiKey: string;
}): string {
	return [parts.pathWithQuery, parts.cookie, parts.profileId, parts.auth, parts.apiKey].join(KEY_SEGMENT_SEPARATOR);
}

export function responseBodyCacheTtlMs(maxAgeSeconds: number): number {
	return Math.min(maxAgeSeconds * 1000, RESPONSE_BODY_CACHE_MAX_TTL_MS);
}

function liveEntry(key: string, now: number): CachedResponseBody | undefined {
	const entry = responseBodyCache.get(key);
	if (!entry) return undefined;

	if (entry.expiresAt <= now) {
		responseBodyCache.delete(key);

		return undefined;
	}

	return entry;
}

export function getCachedResponseBody(key: string, now = Date.now()): CachedResponseBody | undefined {
	return liveEntry(key, now);
}

export function setCachedResponseBody(key: string, entry: CachedResponseBody): void {
	responseBodyCache.set(key, entry);

	const profileId = key.split(KEY_SEGMENT_SEPARATOR)[2];
	if (!profileId) return;

	const keys = profileKeyIndex.get(profileId);
	if (keys) keys.add(key);
	else profileKeyIndex.set(profileId, new Set([key]));
}

/** Reads a withEtagResponse() aggregation body from the shared cache. */
export function getCachedEtagEntry(key: string, now = Date.now()): CachedResponseBody | undefined {
	return liveEntry(key, now);
}

/** Caches an uncompressed aggregation body unless it exceeds RESPONSE_BODY_CACHE_MAX_BYTES. */
export function cacheEtagBody(key: string, body: string, etag: string): void {
	if (body.length > RESPONSE_BODY_CACHE_MAX_BYTES) return;

	responseBodyCache.set(key, {
		etag,
		body,
		expiresAt: Date.now() + ETAG_BODY_CACHE_TTL_MS,
		encoded: new Map(),
	});
	etagBodyKeys.add(key);
}

/** Flushes the response body cache after any write that can stale arbitrary cached GETs. */
export function invalidateResponseBodies(): void {
	responseBodyCache.clear();
	profileKeyIndex.clear();
	etagBodyKeys.clear();
}

/**
 * Drops cached bodies whose request path matches one of `pathPrefixes`
 * (e.g. `/v1/metadata`). Used by writes that only stale a known set of list
 * endpoints — a full flush per ingested file would thrash every cache.
 * `onEvict` keeps the profile/etag indexes in sync.
 */
export function invalidateResponseBodiesForPathPrefixes(pathPrefixes: readonly string[]): void {
	if (pathPrefixes.length === 0) return;

	for (const key of responseBodyCache.keys()) {
		const path = key.split(KEY_SEGMENT_SEPARATOR)[0] ?? "";
		if (pathPrefixes.some((prefix) => path.startsWith(prefix))) responseBodyCache.delete(key);
	}
}

/**
 * Drops cached bodies scoped to one profile without flushing the whole cache.
 * Response-cache keys index by profile id (O(1) per write); etag-body keys
 * embed it after a colon and live only 10s, so that one stays a scan over the
 * etag-key subset.
 */
export function invalidateProfileResponseBodies(profileId: string): void {
	for (const key of profileKeyIndex.get(profileId) ?? []) {
		responseBodyCache.delete(key);
	}
	profileKeyIndex.delete(profileId);

	for (const key of etagBodyKeys) {
		// Etag keys embed the profile id as the last colon-separated segment; a
		// substring match could delete unrelated keys.
		if (key.split(":").at(-1) === profileId) responseBodyCache.delete(key);
	}
}
