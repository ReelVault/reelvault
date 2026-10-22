import { describe, expect, test } from "bun:test";
import { clamp, roundTo } from "./math.utils";

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

describe("roundTo", () => {
	test("rounds to the requested number of decimal places", () => {
		expect(roundTo(1.2345, 2)).toBe(1.23);
		expect(roundTo(1.2355, 2)).toBe(1.24);
		expect(roundTo(1.2345678, 4)).toBe(1.2346);
	});

	test("rounds to a whole number with zero decimals", () => {
		expect(roundTo(1.4, 0)).toBe(1);
		expect(roundTo(1.5, 0)).toBe(2);
		expect(roundTo(2.5, 0)).toBe(3);
	});

	test("leaves a value that already has the requested precision alone", () => {
		expect(roundTo(3, 2)).toBe(3);
		expect(roundTo(3.14, 2)).toBe(3.14);
	});
});
