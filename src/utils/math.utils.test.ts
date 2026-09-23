import { describe, expect, test } from "bun:test";
import { clamp, isValidRating } from "./math.utils";

describe("clamp", () => {
	test("returns the value inside the range", () => {
		expect(clamp(5, 0, 10)).toBe(5);
		expect(clamp(0, 0, 10)).toBe(0);
		expect(clamp(10, 0, 10)).toBe(10);
	});

	test("clamps below the minimum and above the maximum", () => {
		expect(clamp(-5, 0, 10)).toBe(0);
		expect(clamp(15, 0, 10)).toBe(10);
	});
});

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
