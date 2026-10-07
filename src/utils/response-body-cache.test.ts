import { afterEach, describe, expect, test } from "bun:test";
import {
	type CachedResponseBody,
	getCachedResponseBody,
	invalidateResponseBodies,
	invalidateResponseBodiesForPathPrefixes,
	responseCacheKey,
	setCachedResponseBody,
} from "./response-body-cache";

function entry(): CachedResponseBody {
	return { etag: "e", body: "{}", expiresAt: Date.now() + 60_000, encoded: new Map() };
}

function cacheKey(pathWithQuery: string): string {
	return responseCacheKey({ pathWithQuery, cookie: "c", profileId: "p", auth: "", apiKey: "" });
}

afterEach(() => invalidateResponseBodies());

describe("invalidateResponseBodiesForPathPrefixes", () => {
	test("drops only matching request paths", () => {
		const metadataKey = cacheKey("/v1/test-prefix/metadata?page=1");
		const librariesKey = cacheKey("/v1/test-prefix/libraries");
		const settingsKey = cacheKey("/v1/test-prefix/admin/settings");
		setCachedResponseBody(metadataKey, entry());
		setCachedResponseBody(librariesKey, entry());
		setCachedResponseBody(settingsKey, entry());

		invalidateResponseBodiesForPathPrefixes(["/v1/test-prefix/metadata", "/v1/test-prefix/libraries"]);

		expect(getCachedResponseBody(metadataKey)).toBeUndefined();
		expect(getCachedResponseBody(librariesKey)).toBeUndefined();
		expect(getCachedResponseBody(settingsKey)).toBeDefined();
	});

	test("is a no-op for an empty prefix list", () => {
		const key = cacheKey("/v1/test-prefix/keep");
		setCachedResponseBody(key, entry());

		invalidateResponseBodiesForPathPrefixes([]);

		expect(getCachedResponseBody(key)).toBeDefined();
	});
});
