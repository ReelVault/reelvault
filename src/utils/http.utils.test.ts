import { describe, expect, it } from "bun:test";
import { escapeRegex, matchesIfNoneMatch, parseAllowedOrigins, requestIdentityKey } from "./http.utils";

describe("requestIdentityKey", () => {
	const url = "http://localhost/v1/items?page=2";
	const headers = {
		authorization: "Bearer token",
		cookie: "session=abc",
		"x-profile-id": "profile-1",
		"x-api-key": "machine-key",
	};
	// The key segments are joined with a NUL, in the order path, cookie, profile, auth, api key.
	const headerProfileKey = "/v1/items?page=2\u0000session=abc\u0000profile-1\u0000Bearer token\u0000machine-key";

	it("scopes the key by path, credentials and the header profile", () => {
		const key = requestIdentityKey(new Request(url, { headers }));

		expect(key).toBe(headerProfileKey);
	});

	it("lets a resolved profile override the header and separates GET from HEAD", () => {
		const getKey = requestIdentityKey(new Request(url, { headers }), { includeMethod: true });
		const headKey = requestIdentityKey(new Request(url, { method: "HEAD", headers }), { includeMethod: true });
		const resolvedProfileKey = requestIdentityKey(new Request(url, { headers }), { profileId: "profile-2" });

		expect(getKey).toBe(`GET:${headerProfileKey}`);
		expect(headKey).toBe(`HEAD:${headerProfileKey}`);
		expect(resolvedProfileKey).toBe("/v1/items?page=2\u0000session=abc\u0000profile-2\u0000Bearer token\u0000machine-key");
	});
});

describe("http.utils", () => {
	describe("escapeRegex", () => {
		it("escapes special regex characters", () => {
			expect(escapeRegex("hello.world*foo?")).toBe(String.raw`hello\.world\*foo\?`);
			expect(escapeRegex(String.raw`a+b(c)[d]{e}^f$g|h\i`)).toBe(String.raw`a\+b\(c\)\[d\]\{e\}\^f\$g\|h\\i`);
		});
	});

	describe("parseAllowedOrigins", () => {
		it("parses comma-separated origins and trims spaces", () => {
			const parsed = parseAllowedOrigins("http://localhost:3000, http://reelvault.lan:3000 , https://custom.domain.com");
			expect(parsed).toEqual(["http://localhost:3000", "http://reelvault.lan:3000", "https://custom.domain.com"]);
		});

		it("accepts an array of origins", () => {
			const parsed = parseAllowedOrigins(["http://localhost:3000", " http://*.ts:* "]);
			expect(parsed).toEqual(["http://localhost:3000", "http://*.ts:*"]);
		});

		it("parseAllowedOrigins returns no origins for undefined, empty string or empty array", () => {
			expect(parseAllowedOrigins(undefined)).toEqual([]);
			expect(parseAllowedOrigins("")).toEqual([]);
			expect(parseAllowedOrigins([])).toEqual([]);
		});
	});

	describe("matchesIfNoneMatch", () => {
		it("matches the exact, weak and wildcard validators", () => {
			expect(matchesIfNoneMatch('"abc"', '"abc"')).toBe(true);
			expect(matchesIfNoneMatch('W/"abc"', '"abc"')).toBe(true);
			expect(matchesIfNoneMatch('"stale", "abc"', '"abc"')).toBe(true);
			expect(matchesIfNoneMatch("*", '"abc"')).toBe(true);
			expect(matchesIfNoneMatch(null, '"abc"')).toBe(false);
			expect(matchesIfNoneMatch('"other"', '"abc"')).toBe(false);
		});
	});
});
