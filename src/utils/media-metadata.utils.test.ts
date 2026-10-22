import { describe, expect, test } from "bun:test";
import { isValidRating } from "./media-metadata.utils";

describe("isValidRating", () => {
	test("accepts a non-empty source with a finite value", () => {
		expect(isValidRating({ source: "tmdb", value: 7.5 })).toBe(true);
		expect(isValidRating({ source: "user", value: 0 })).toBe(true);
	});

	test("rejects empty sources and non-finite values", () => {
		expect(isValidRating({ source: "", value: 7.5 })).toBe(false);
		expect(isValidRating({ source: "  ", value: 7.5 })).toBe(false);
		expect(isValidRating({ source: "tmdb", value: Number.NaN })).toBe(false);
		expect(isValidRating({ source: "tmdb", value: Number.POSITIVE_INFINITY })).toBe(false);
	});
});
