import { runLoadWindow } from "./load";
import { fmtMs, printTable } from "./report";
import { type LatencyStats, summarizeLatencies } from "./stats";

export interface MicroBenchmarkResult {
	name: string;
	timesMs: number[];
	/** Number of rows when the measured operation returns an array (SQL benchmarks). */
	rows?: number;
}

/**
 * Drop-in replacement for synchronous microbenchmarks: warmup, timed iterations,
 * and optional row counting.
 */
export function benchmark(
	name: string,
	operation: (iteration: number) => unknown,
	options: { warmup?: number; iterations?: number } = {},
): MicroBenchmarkResult {
	const result = measure(name, operation, options);
	const produced = operation(-1);

	return { ...result, ...(Array.isArray(produced) ? { rows: produced.length } : {}) };
}

/**
 * Runs `operation` warmup times synchronously, then measures `iterations` runs.
 */
export function measure(
	name: string,
	operation: (iteration: number) => unknown,
	options: { warmup?: number; iterations?: number } = {},
): MicroBenchmarkResult {
	const warmup = options.warmup ?? 10;
	const iterations = options.iterations ?? 100;
	for (let index = 0; index < warmup; index++) operation(index);

	const timesMs: number[] = [];
	for (let index = 0; index < iterations; index++) {
		const startedAt = performance.now();
		operation(index);
		timesMs.push(performance.now() - startedAt);
	}

	return { name, timesMs };
}

/**
 * Asynchronous microbenchmark harness: warmup, timed iterations, and optional row counting.
 */
export async function benchmarkAsync(
	name: string,
	operation: (iteration: number) => Promise<unknown>,
	options: { warmup?: number; iterations?: number } = {},
): Promise<MicroBenchmarkResult> {
	const result = await measureAsync(name, operation, options);
	const produced = await operation(-1);

	return { ...result, ...(Array.isArray(produced) ? { rows: produced.length } : {}) };
}

/**
 * Runs async `operation` warmup times, then measures `iterations` runs.
 */
export async function measureAsync(
	name: string,
	operation: (iteration: number) => Promise<unknown>,
	options: { warmup?: number; iterations?: number } = {},
): Promise<MicroBenchmarkResult> {
	const warmup = options.warmup ?? 5;
	const iterations = options.iterations ?? 50;
	for (let index = 0; index < warmup; index++) {
		await operation(index);
	}

	const timesMs: number[] = [];
	for (let index = 0; index < iterations; index++) {
		const startedAt = performance.now();
		await operation(index);
		timesMs.push(performance.now() - startedAt);
	}

	return { name, timesMs };
}

export function printMicroResults(results: readonly MicroBenchmarkResult[], title = "Results (lower is better)"): void {
	printTable(
		title,
		["benchmark", "p50", "p95", "p99", "max", "rows"],
		results.map((result) => {
			const stats = summarizeLatencies(result.timesMs);

			return [
				result.name,
				fmtMs(stats.p50Ms),
				fmtMs(stats.p95Ms),
				fmtMs(stats.p99Ms),
				fmtMs(stats.maxMs),
				result.rows !== undefined ? String(result.rows) : "-",
			];
		}),
	);
}

export interface HttpScenarioResult {
	name: string;
	stats: LatencyStats;
	requestsPerSecond: number;
	/** Percentage of requests that did not return a successful response. */
	errorRatePercent: number;
}

/** Raw per-scenario window outcome, aggregated the way HTTP suites report it. */
export interface HttpScenarioRun {
	latencies: number[];
	successes: number;
	requests: number;
}

export interface HttpScenarioOptions {
	concurrency: number;
	warmupMs: number;
	durationMs: number;
	work: (workerIndex: number, requestIndex: number) => Promise<{ ok: boolean }>;
}

/**
 * Windowed load for one HTTP scenario, aggregated the way the suites report:
 * post-warmup, success-only latencies.
 */
export async function runHttpScenario(options: HttpScenarioOptions): Promise<HttpScenarioRun> {
	const run = await runLoadWindow({ ...options, work: options.work });

	return { latencies: run.successLatencies, successes: run.successes, requests: run.requests };
}

/** Aggregates one scenario run into the printable/JSON result row. */
export function httpScenarioResult(
	scenarioName: string,
	concurrency: number | string,
	run: HttpScenarioRun,
	durationMs: number,
): HttpScenarioResult {
	const stats = summarizeLatencies(run.latencies);

	return {
		name: `c=${concurrency} ${scenarioName}`,
		stats,
		requestsPerSecond: run.successes / (durationMs / 1000),
		errorRatePercent: run.requests > 0 ? ((run.requests - run.successes) / run.requests) * 100 : 0,
	};
}

export function printHttpResults(results: readonly HttpScenarioResult[]): void {
	printTable(
		"Results (successful responses only; higher req/s is better)",
		["scenario", "req/s", "errors", "p50", "p95", "p99", "max", "samples"],
		results.map((result) => [
			result.name,
			result.requestsPerSecond.toFixed(1),
			`${result.errorRatePercent.toFixed(1)}%`,
			fmtMs(result.stats.p50Ms),
			fmtMs(result.stats.p95Ms),
			fmtMs(result.stats.p99Ms),
			fmtMs(result.stats.maxMs),
			String(result.stats.count),
		]),
	);
}
