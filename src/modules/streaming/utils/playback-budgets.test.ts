import { describe, expect, test } from "bun:test";
import { clampSeekOffsetToDuration } from "./playback-budgets";

describe("clampSeekOffsetToDuration", () => {
	test("rejects non-positive and non-finite offsets", () => {
		expect(clampSeekOffsetToDuration(0)).toBe(0);
		expect(clampSeekOffsetToDuration(-5)).toBe(0);
		expect(clampSeekOffsetToDuration(Number.NaN)).toBe(0);
		expect(clampSeekOffsetToDuration(Number.POSITIVE_INFINITY)).toBe(0);
	});

	test("passes the offset through when duration is unknown", () => {
		expect(clampSeekOffsetToDuration(120)).toBe(120);
		expect(clampSeekOffsetToDuration(120, undefined)).toBe(120);
		expect(clampSeekOffsetToDuration(120, null)).toBe(120);
		expect(clampSeekOffsetToDuration(120, 0)).toBe(120);
		expect(clampSeekOffsetToDuration(120, Number.NaN)).toBe(120);
	});

	test("keeps offsets inside the playable window untouched", () => {
		expect(clampSeekOffsetToDuration(59, 120)).toBe(59);
		expect(clampSeekOffsetToDuration(119, 120)).toBe(119);
	});

	test("clamps to 1 s before the end — a seek to the exact EOF consumes zero packets", () => {
		expect(clampSeekOffsetToDuration(119.5, 120)).toBe(119);
		expect(clampSeekOffsetToDuration(120, 120)).toBe(119);
		expect(clampSeekOffsetToDuration(500, 120)).toBe(119);
	});

	test("content shorter than the guard clamps to 0", () => {
		expect(clampSeekOffsetToDuration(10, 0.5)).toBe(0);
		expect(clampSeekOffsetToDuration(10, 1)).toBe(0);
	});
});
