import { afterEach, describe, expect, test } from "bun:test";
import {
	CATALOG_LIST_PATH_PREFIXES,
	type CachedResponseBody,
	getCachedResponseBody,
	invalidateResponseBodies,
	invalidateResponseBodiesForPathPrefixes,
	responseCacheKey,
	setCachedResponseBody,
} from "./response-body.cache";

// `expiresAt` comes from the clock, so a test keeps the entry it stores and compares against that same object.
function entry(): CachedResponseBody {
	return { etag: "e", body: "{}", expiresAt: Date.now() + 60_000, encoded: new Map() };
}

function cacheKey(pathWithQuery: string): string {
	return responseCacheKey({ pathWithQuery, cookie: "c", profileId: "p", auth: "", apiKey: "" });
}

afterEach(() => invalidateResponseBodies());

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

	test("is a no-op for an empty prefix list", () => {
		const key = cacheKey("/v1/profiles");
		const stored = entry();
		setCachedResponseBody(key, stored);

		invalidateResponseBodiesForPathPrefixes([]);

		expect(getCachedResponseBody(key)).toEqual(stored);
	});
});
