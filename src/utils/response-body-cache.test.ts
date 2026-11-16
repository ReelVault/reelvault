import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
	CATALOG_LIST_PATH_PREFIXES,
	type CachedResponseBody,
	getCachedResponseBody,
	invalidateProfileResponseBodies,
	invalidateResponseBodies,
	invalidateResponseBodiesForPathPrefixes,
	responseBodyCacheTtlMs,
	responseBodyEpoch,
	responseCacheKey,
	setCachedResponseBody,
	setEtagResponseBody,
} from "./response-body.cache";

/** Fixed instant for tests that assert a stored expiry. */
const FIXED_NOW_MS = new Date("2026-01-01T00:00:00.000Z").getTime();

// `expiresAt` comes from the clock, so a test keeps the entry it stores and compares against that same object.
function entry(): CachedResponseBody {
	return { etag: "e", body: "{}", expiresAt: Date.now() + 60_000, encoded: new Map() };
}

function cacheKey(pathWithQuery: string): string {
	return responseCacheKey({ pathWithQuery, cookie: "c", profileId: "p", auth: "", apiKey: "" });
}

afterEach(() => {
	invalidateResponseBodies();
	setSystemTime();
});

describe("cache entries", () => {
	test("clamps the route TTL to five minutes", () => {
		expect(responseBodyCacheTtlMs(60)).toBe(60_000);
		expect(responseBodyCacheTtlMs(300)).toBe(300_000);
		expect(responseBodyCacheTtlMs(600)).toBe(300_000);
		expect(responseBodyCacheTtlMs(0)).toBe(0);
	});

	test("returns a live entry and drops an expired one", () => {
		const live = entry();
		setCachedResponseBody(cacheKey("/v1/live"), live);
		const expired = { ...entry(), expiresAt: Date.now() - 1 };
		setCachedResponseBody(cacheKey("/v1/expired"), expired);

		expect(getCachedResponseBody(cacheKey("/v1/live"))).toEqual(live);
		expect(getCachedResponseBody(cacheKey("/v1/expired"))).toBeUndefined();
		expect(getCachedResponseBody(cacheKey("/v1/expired"))).toBeUndefined();
	});

	test("treats an entry expiring exactly now as expired", () => {
		setCachedResponseBody(cacheKey("/v1/boundary"), { ...entry(), expiresAt: FIXED_NOW_MS });

		expect(getCachedResponseBody(cacheKey("/v1/boundary"), FIXED_NOW_MS)).toBeUndefined();
	});

	test("caches an etag body for ten seconds", () => {
		setSystemTime(new Date(FIXED_NOW_MS));
		const key = cacheKey("/v1/etag-ttl");

		setEtagResponseBody(key, "body", "etag");

		expect(getCachedResponseBody(key)?.expiresAt).toBe(FIXED_NOW_MS + 10_000);
	});

	test("caches etag bodies under the size cap and skips oversized ones", () => {
		const oversized = "x".repeat(524_289);
		const atCap = "x".repeat(524_288);
		const key = cacheKey("/v1/etag");

		setEtagResponseBody(key, oversized, "oversized");
		expect(getCachedResponseBody(key)).toBeUndefined();

		setEtagResponseBody(key, atCap, "at-cap");
		expect(getCachedResponseBody(key)).toMatchObject({ etag: "at-cap", body: atCap });
	});

	test("evicts the oldest entry once the count cap is reached", () => {
		const stored = entry();
		for (let index = 0; index <= 8192; index++) setCachedResponseBody(cacheKey(`/v1/page/${index}`), stored);

		expect(getCachedResponseBody(cacheKey("/v1/page/0"))).toBeUndefined();
		expect(getCachedResponseBody(cacheKey("/v1/page/1"))).toEqual(stored);
	});

	test("invalidates only the requested profile", () => {
		const first = responseCacheKey({ pathWithQuery: "/v1/a", cookie: "c", profileId: "p1", auth: "", apiKey: "" });
		const second = responseCacheKey({ pathWithQuery: "/v1/b", cookie: "c", profileId: "p2", auth: "", apiKey: "" });
		const firstEntry = entry();
		const secondEntry = entry();
		setCachedResponseBody(first, firstEntry);
		setCachedResponseBody(second, secondEntry);

		invalidateProfileResponseBodies("p1");

		expect(getCachedResponseBody(first)).toBeUndefined();
		expect(getCachedResponseBody(second)).toEqual(secondEntry);
	});

	test("advances the epoch on a full flush", () => {
		const before = responseBodyEpoch();
		setCachedResponseBody(cacheKey("/v1/a"), entry());

		invalidateResponseBodies();

		expect(responseBodyEpoch()).toBe(before + 1);
		expect(getCachedResponseBody(cacheKey("/v1/a"))).toBeUndefined();
	});
});

describe("catalog list flushes", () => {
	const catalogLists = [
		"/v1/people?limit=20",
		"/v1/companies?limit=20",
		"/v1/genres?limit=20",
		"/v1/keywords?limit=20",
		"/v1/collections?limit=20",
	];

	test("a catalog flush drops those lists and keeps unrelated responses", () => {
		const profiles = entry();
		for (const path of catalogLists) setCachedResponseBody(cacheKey(path), entry());
		setCachedResponseBody(cacheKey("/v1/profiles"), profiles);

		invalidateResponseBodiesForPathPrefixes(CATALOG_LIST_PATH_PREFIXES);

		for (const path of catalogLists) expect(getCachedResponseBody(cacheKey(path))).toBeUndefined();
		expect(getCachedResponseBody(cacheKey("/v1/profiles"))).toEqual(profiles);
	});
});

describe("invalidateResponseBodiesForPathPrefixes", () => {
	test("drops only matching request paths", () => {
		const metadataKey = cacheKey("/v1/test-prefix/metadata?page=1");
		const librariesKey = cacheKey("/v1/test-prefix/libraries");
		const settingsKey = cacheKey("/v1/test-prefix/admin/settings");
		const settings = entry();
		setCachedResponseBody(metadataKey, entry());
		setCachedResponseBody(librariesKey, entry());
		setCachedResponseBody(settingsKey, settings);

		invalidateResponseBodiesForPathPrefixes(["/v1/test-prefix/metadata", "/v1/test-prefix/libraries"]);

		expect(getCachedResponseBody(metadataKey)).toBeUndefined();
		expect(getCachedResponseBody(librariesKey)).toBeUndefined();
		expect(getCachedResponseBody(settingsKey)).toEqual(settings);
	});

	test("drops a single matching prefix and advances the epoch", () => {
		const before = responseBodyEpoch();
		const metadataKey = cacheKey("/v1/single-prefix/metadata?page=1");
		const settingsKey = cacheKey("/v1/single-prefix/admin/settings");
		const settings = entry();
		setCachedResponseBody(metadataKey, entry());
		setCachedResponseBody(settingsKey, settings);

		invalidateResponseBodiesForPathPrefixes(["/v1/single-prefix/metadata"]);

		expect(responseBodyEpoch()).toBe(before + 1);
		expect(getCachedResponseBody(metadataKey)).toBeUndefined();
		expect(getCachedResponseBody(settingsKey)).toEqual(settings);
	});

	test("leaves the epoch alone when no cached body matched", () => {
		const before = responseBodyEpoch();
		setCachedResponseBody(cacheKey("/v1/nomatch/profiles"), entry());

		invalidateResponseBodiesForPathPrefixes(["/v1/nomatch/metadata"]);

		expect(responseBodyEpoch()).toBe(before);
	});

	test("is a no-op for an empty prefix list", () => {
		const before = responseBodyEpoch();
		const key = cacheKey("/v1/profiles");
		const stored = entry();
		setCachedResponseBody(key, stored);

		invalidateResponseBodiesForPathPrefixes([]);

		expect(responseBodyEpoch()).toBe(before);
		expect(getCachedResponseBody(key)).toEqual(stored);
	});
});
