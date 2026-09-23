import { describe, expect, test } from "bun:test";
import { percentile, summarizeLatencies } from "./stats";

describe("percentile", () => {
	test("returns 0 for an empty sample", () => {
		expect(percentile([], 50)).toBe(0);
	});

	test("nearest-rank: p50 of 1..4 is 2", () => {
		expect(percentile([4, 1, 3, 2], 50)).toBe(2);
	});

	test("nearest-rank: p100 is the max, p0 is the min", () => {
		expect(percentile([4, 1, 3, 2], 100)).toBe(4);
		expect(percentile([4, 1, 3, 2], 1)).toBe(1);
	});
});

describe("summarizeLatencies", () => {
	test("empty sample yields zeroed stats", () => {
		expect(summarizeLatencies([])).toEqual({ count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 });
	});

	test("computes mean, percentiles and max", () => {
		const stats = summarizeLatencies([1, 2, 3, 4, 5]);
		expect(stats.count).toBe(5);
		expect(stats.meanMs).toBe(3);
		expect(stats.p50Ms).toBe(3);
		expect(stats.p95Ms).toBe(5);
		expect(stats.p99Ms).toBe(5);
		expect(stats.maxMs).toBe(5);
	});
});
