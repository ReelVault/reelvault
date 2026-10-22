import { describe, expect, test } from "bun:test";
import { growthVerdict, levelsOff, linearSlope } from "./trend.utils";

const MB = 1024 * 1024;

describe("linearSlope", () => {
	test("is the per-round growth of a straight line", () => {
		expect(linearSlope([1, 2, 3, 4])).toBe(1);
		expect(linearSlope([10, 8, 6])).toBe(-2);
	});

	test("is zero for a flat series and for fewer than two samples", () => {
		expect(linearSlope([5, 5, 5])).toBe(0);
		expect(linearSlope([7])).toBe(0);
	});
});

describe("levelsOff", () => {
	test("rejects a series that keeps climbing", () => {
		expect(levelsOff([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111], 0.5)).toBe(false);
	});

	test("accepts a series that climbs while caches fill and then holds", () => {
		expect(levelsOff([100, 104, 108, 110, 110, 110, 110, 110, 110, 110, 110, 110], 0.5)).toBe(true);
	});
});

describe("growthVerdict", () => {
	test("flags a steady 1 MB-per-round climb on a 200 MB process as growing", () => {
		const climbing = Array.from({ length: 12 }, (_, round) => 200 * MB + round * MB);

		expect(growthVerdict(climbing, 512 * 1024)).toEqual({ slope: MB, levelled: false, growing: true });
	});

	test("does not flag a climb that levels off", () => {
		const verdict = growthVerdict([100, 104, 108, 110, 110, 110, 110, 110, 110, 110, 110, 110], 0.1);

		expect(verdict.growing).toBe(false);
	});
});
