import { systemResourcesService } from "@/config/system-resources.service";
import { KIB, MIB } from "@/utils/bytes.utils";
import { MemoryCache } from "@/utils/memory.cache";

/** Serialized JSON body plus per-encoding compressed variants, reused across requests. */
export interface CachedResponseBody {
	etag: string;
	body: string;
	expiresAt: number;
	encoded: Map<string, Uint8Array<ArrayBuffer>>;
}

/** Hard ceiling on a cacheable response body — oversized payloads are still served, just not cached. */
export const RESPONSE_BODY_CACHE_MAX_BYTES = 512 * KIB;
/** Server-side TTL cap regardless of the route's client-facing max-age. */
const RESPONSE_BODY_CACHE_MAX_TTL_MS = 5 * 60_000;
/** TTL of the short-lived aggregation bodies stored by withEtagResponse(). */
export const ETAG_BODY_CACHE_TTL_MS = 10_000;
/**
 * Total byte budget across all cached bodies: RESPONSE_BODY_CACHE_BYTES_PER_GB for each GiB of
 * installed RAM, clamped to [MIN, MAX]. A catalog list page is ~22 KB, so a 30 GB box holds
 * ~2,800 pages — a 512-entry count cap held only ~11 MB and thrashed on wider browse patterns.
 */
const RESPONSE_BODY_CACHE_BYTES_PER_GB = 2 * MIB;
const RESPONSE_BODY_CACHE_MIN_TOTAL_BYTES = 32 * MIB;
const RESPONSE_BODY_CACHE_MAX_TOTAL_BYTES = 256 * MIB;
/** Entry-count safety net for many small bodies; the byte budget is the real limit. */
const RESPONSE_BODY_CACHE_MAX_ENTRIES = 8192;

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

/** The n-th `\u0000`-separated segment of a cache key, without splitting the rest. */
function keySegment(key: string, index: number): string | undefined {
	let start = 0;
	for (let i = 0; i < index; i++) {
		const next = key.indexOf(KEY_SEGMENT_SEPARATOR, start);
		if (next === -1) return undefined;
		start = next + 1;
	}
	const end = key.indexOf(KEY_SEGMENT_SEPARATOR, start);

	return end === -1 ? key.slice(start) : key.slice(start, end);
}

/**
 * profileId → cached keys. invalidateProfileResponseBodies() runs on EVERY
 * progress/watchlist write (each stream heartbeat), so invalidation must be a
 * Set lookup, not a full cache scan. Route-level (`cache` macro) and
 * withEtagResponse() bodies share the key format and this index.
 */
const profileKeyIndex = new Map<string, Set<string>>();

function removeFromProfileIndex(key: string): void {
	const profileId = keySegment(key, 2);
	if (!profileId) return;

	const keys = profileKeyIndex.get(profileId);
	if (!keys) return;

	keys.delete(key);
	if (keys.size === 0) profileKeyIndex.delete(profileId);
}

const responseBodyCache = new MemoryCache<CachedResponseBody>({
	// TTL is enforced per entry (expiresAt) so each route keeps its own max-age.
	ttlMs: -1,
	maxSize: RESPONSE_BODY_CACHE_MAX_ENTRIES,
	maxWeight: systemResourcesService.getRamScaled(
		RESPONSE_BODY_CACHE_BYTES_PER_GB,
		RESPONSE_BODY_CACHE_MIN_TOTAL_BYTES,
		RESPONSE_BODY_CACHE_MAX_TOTAL_BYTES,
	),
	// Uncompressed body length. Compressed variants are memoized later and not charged; for a
	// catalog list page each is only about 5–10% of the body (br ≈ 1.2 KB, gzip ≈ 2.2 KB at 22.5 KB).
	weigh: (entry) => entry.body.length,
	name: "api.responseBody",
	// Keep the per-profile index honest across LRU evictions.
	onEvict: (key) => {
		removeFromProfileIndex(key);
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

/** Live (unexpired) body for a route-level or withEtagResponse() cache key. */
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

	const profileId = keySegment(key, 2);
	if (!profileId) return;

	const keys = profileKeyIndex.get(profileId);
	if (keys) keys.add(key);
	else profileKeyIndex.set(profileId, new Set([key]));
}

/** Caches an uncompressed aggregation body unless it exceeds RESPONSE_BODY_CACHE_MAX_BYTES. */
export function setEtagResponseBody(key: string, body: string, etag: string): void {
	if (body.length > RESPONSE_BODY_CACHE_MAX_BYTES) return;

	setCachedResponseBody(key, {
		etag,
		body,
		expiresAt: Date.now() + ETAG_BODY_CACHE_TTL_MS,
		encoded: new Map(),
	});
}

let invalidationEpoch = 0;

/**
 * Advances on every flush of shared list bodies. Data that list bodies embed but that is
 * cached on its own (collection poster previews) records the epoch it was read under and
 * treats an older one as a miss, so the write that flushed the bodies also drops it.
 * Profile-scoped writes leave it unchanged: no shared list embeds profile state.
 */
export function responseBodyEpoch(): number {
	return invalidationEpoch;
}

/** Flushes the response body cache after any write that can stale arbitrary cached GETs. */
export function invalidateResponseBodies(): void {
	invalidationEpoch++;
	responseBodyCache.clear();
	profileKeyIndex.clear();
}

/**
 * Drops cached bodies whose request path matches one of `pathPrefixes`
 * (e.g. `/v1/metadata`). Used by writes that only stale a known set of list
 * endpoints — a full flush per ingested file would thrash every cache.
 * `onEvict` keeps the profile/etag indexes in sync.
 */
/**
 * Cached catalog list routes that embed a title, its people/companies/genres or its library's stats —
 * everything a scan, an ingest or a metadata refresh can make stale.
 */
export const CATALOG_LIST_PATH_PREFIXES = [
	"/v1/metadata",
	"/v1/libraries",
	"/v1/people",
	"/v1/companies",
	"/v1/genres",
	"/v1/keywords",
	"/v1/collections",
] as const;

export function invalidateResponseBodiesForPathPrefixes(pathPrefixes: readonly string[]): void {
	if (pathPrefixes.length === 0) return;

	invalidationEpoch++;
	for (const key of responseBodyCache.keys()) {
		const path = keySegment(key, 0) ?? "";
		if (pathPrefixes.some((prefix) => path.startsWith(prefix))) responseBodyCache.delete(key);
	}
}

/**
 * Drops cached bodies scoped to one profile without flushing the whole cache:
 * route-level and withEtagResponse() keys both index by profile id, so this is
 * an O(1) lookup per write.
 */
export function invalidateProfileResponseBodies(profileId: string): void {
	for (const key of profileKeyIndex.get(profileId) ?? []) {
		responseBodyCache.delete(key);
	}
	profileKeyIndex.delete(profileId);
}
