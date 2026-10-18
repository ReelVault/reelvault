import { describe, expect, test } from "bun:test";
import {
	type BenchBaselineEntry,
	compareBaselineEntry,
	compareTaskMetrics,
	compareWithBaseline,
	mannWhitneyZ,
	type TaskBaselineEntry,
} from "./baseline.utils";
import { metric, type TaskMetrics } from "./metrics.utils";

function entry(file: string, name: string, samples: number[]): BenchBaselineEntry {
	return { kind: "bench", file, name, samples, p50Ms: samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0 };
}

function taskEntry(file: string, name: string, metrics: TaskMetrics): TaskBaselineEntry {
	return { kind: "task", file, name, metrics };
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

	test("a delta under the 3% practical threshold is unchanged", () => {
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

	test("compares task metrics by direction and counts kind mismatches", () => {
		const baseline = [taskEntry("http", "http: scenarios", { "c=50 health req/s": metric(1000, true) })];
		const current = [
			taskEntry("http", "http: scenarios", { "c=50 health req/s": metric(1100, true) }),
			entry("http", "http: scenarios", [9, 9, 9]),
		];
		const { comparisons, missingInBaseline } = compareWithBaseline(current, baseline);
		expect(comparisons).toHaveLength(1);
		expect(comparisons[0]?.name).toBe("c=50 health req/s");
		expect(comparisons[0]?.verdict).toBe("faster");
		expect(missingInBaseline).toBe(1);
	});
});

describe("compareTaskMetrics", () => {
	test("higher-is-better metric up → faster, down → slower", () => {
		const baseline = taskEntry("http", "http: scenarios", { "req/s": metric(1000, true) });
		expect(
			compareTaskMetrics(taskEntry("http", "http: scenarios", { "req/s": metric(1100, true) }), baseline).comparisons[0]?.verdict,
		).toBe("faster");
		expect(compareTaskMetrics(taskEntry("http", "http: scenarios", { "req/s": metric(900, true) }), baseline).comparisons[0]?.verdict).toBe(
			"slower",
		);
	});

	test("lower-is-better metric down → faster, up → slower", () => {
		const baseline = taskEntry("http", "http: scenarios", { "p95 ms": metric(10, false) });
		expect(compareTaskMetrics(taskEntry("http", "http: scenarios", { "p95 ms": metric(9, false) }), baseline).comparisons[0]?.verdict).toBe(
			"faster",
		);
		expect(
			compareTaskMetrics(taskEntry("http", "http: scenarios", { "p95 ms": metric(11, false) }), baseline).comparisons[0]?.verdict,
		).toBe("slower");
	});

	test("tiny delta → unchanged", () => {
		const baseline = taskEntry("http", "http: scenarios", { "req/s": metric(1000, true) });
		expect(
			compareTaskMetrics(taskEntry("http", "http: scenarios", { "req/s": metric(1020, true) }), baseline).comparisons[0]?.verdict,
		).toBe("unchanged");
	});

	test("a metric missing from the baseline counts as missing", () => {
		const baseline = taskEntry("http", "http: scenarios", { "req/s": metric(1000, true) });
		const result = compareTaskMetrics(taskEntry("http", "http: scenarios", { "new req/s": metric(1, true) }), baseline);
		expect(result.comparisons).toHaveLength(0);
		expect(result.missingInBaseline).toBe(1);
	});
});
