import { describe, expect, test } from "bun:test";
import { type BaselineEntry, compareBaselineEntry, compareWithBaseline, mannWhitneyZ } from "./baseline";

function entry(file: string, name: string, samples: number[]): BaselineEntry {
	return { kind: "bench", file, name, samples, p50Ms: samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0 };
}

describe("mannWhitneyZ", () => {
	test("identical distributions give a small z", () => {
		const samples = Array.from({ length: 40 }, (_, i) => 10 + (i % 3) * 0.01);
		expect(Math.abs(mannWhitneyZ(samples, samples))).toBeLessThan(0.3);
	});

	test("clearly shifted distributions give a large |z|", () => {
		const a = Array.from({ length: 30 }, (_, i) => 9 + (i % 5) * 0.01);
		const b = Array.from({ length: 30 }, (_, i) => 11 + (i % 5) * 0.01);
		expect(Math.abs(mannWhitneyZ(a, b))).toBeGreaterThan(4);
	});
});

describe("compareBaselineEntry", () => {
	const baseline = entry("db", "browse", [10, 10.1, 10, 9.9, 10, 10.1, 10, 10, 10.2, 10]);

	test("clear improvement → faster", () => {
		const current = entry("db", "browse", [9, 9.1, 9, 8.9, 9, 9.1, 9, 9, 9.2, 9]);
		expect(compareBaselineEntry(current, baseline).verdict).toBe("faster");
	});

	test("clear regression → slower", () => {
		const current = entry("db", "browse", [12, 12.1, 12, 11.9, 12, 12.1, 12, 12, 12.2, 12]);
		expect(compareBaselineEntry(current, baseline).verdict).toBe("slower");
	});

	test("tiny delta → unchanged even when significant", () => {
		const current = entry("db", "browse", [10.05, 10.05, 10.06, 10.05, 10.05, 10.04, 10.05, 10.05, 10.05, 10.05]);
		expect(compareBaselineEntry(current, baseline).verdict).toBe("unchanged");
	});

	test("large delta with overlapping scatter → noisy", () => {
		const baseline = entry(
			"db",
			"browse",
			Array.from({ length: 11 }, (_, i) => 9 + i * 0.2),
		);
		const current = entry(
			"db",
			"browse",
			Array.from({ length: 11 }, (_, i) => 9.4 + i * 0.2),
		);
		const comparison = compareBaselineEntry(current, baseline);
		expect(comparison.deltaPercent).toBeGreaterThanOrEqual(3);
		expect(comparison.verdict).toBe("noisy");
	});

	test("too few current samples → noisy regardless of delta", () => {
		const current = entry("db", "browse", [9, 9, 9, 9, 9]);
		expect(compareBaselineEntry(current, baseline).verdict).toBe("noisy");
	});
});

describe("compareWithBaseline", () => {
	test("matches by file/name and counts missing", () => {
		const baseline = [entry("db", "browse", [10, 10, 10, 10, 10, 10, 10, 10, 10, 10.1])];
		const current = [entry("db", "browse", [9, 9, 9, 9, 9, 9, 9, 9, 9, 9.1]), entry("db", "browse-new", [9, 9, 9, 9, 9, 9, 9, 9, 9, 9.1])];
		const { comparisons, missingInBaseline } = compareWithBaseline(current, baseline);
		expect(comparisons).toHaveLength(1);
		expect(missingInBaseline).toBe(1);
		expect(comparisons[0]?.verdict).toBe("faster");
	});
});
