import { describe, expect, it } from "bun:test";
import { escapeRegex, matchesIfNoneMatch, parseAllowedOrigins } from "./http.utils";

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
