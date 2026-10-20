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

	it("scopes the key by path, credentials and the header profile", () => {
		const key = requestIdentityKey(new Request(url, { headers }));

		expect(key).toContain("/v1/items?page=2");
		expect(key).toContain("session=abc");
		expect(key).toContain("Bearer token");
		expect(key).toContain("profile-1");
		expect(key).toContain("machine-key");
	});

	it("lets a resolved profile override the header and separates GET from HEAD", () => {
		const getKey = requestIdentityKey(new Request(url, { headers }), { includeMethod: true });
		const headKey = requestIdentityKey(new Request(url, { method: "HEAD", headers }), { includeMethod: true });
		const resolvedProfileKey = requestIdentityKey(new Request(url, { headers }), { profileId: "profile-2" });

		expect(getKey.startsWith("GET:")).toBeTrue();
		expect(headKey.startsWith("HEAD:")).toBeTrue();
		expect(getKey).not.toBe(headKey);
		expect(resolvedProfileKey).not.toBe(requestIdentityKey(new Request(url, { headers })));
	});
});

describe("http.utils", () => {
	describe("escapeRegex", () => {
		it("escapes special regex characters", () => {
			expect(escapeRegex("hello.world*foo?")).toBe("hello\\.world\\*foo\\?");
			expect(escapeRegex("a+b(c)[d]{e}^f$g|h\\i")).toBe("a\\+b\\(c\\)\\[d\\]\\{e\\}\\^f\\$g\\|h\\\\i");
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
