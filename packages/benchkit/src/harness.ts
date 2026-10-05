import { runLoadWindow } from "./load";
import { fmtMs, printTable } from "./report";
import { type LatencyStats, summarizeLatencies } from "./stats";

export interface MicroBenchmarkResult {
	name: string;
	timesMs: number[];
	/** Number of rows when the measured operation returns an array (SQL benchmarks). */
	rows?: number;
}

/** Adds the measured operation's row count when it produced an array. */
function withRows(result: MicroBenchmarkResult, produced: unknown): MicroBenchmarkResult {
	return { ...result, ...(Array.isArray(produced) ? { rows: produced.length } : {}) };
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
	return withRows(measure(name, operation, options), operation(-1));
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
	return withRows(await measureAsync(name, operation, options), await operation(-1));
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

			return [result.name, ...statCells(stats), result.rows !== undefined ? String(result.rows) : "-"];
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

/** Builds the request issued once per load-window iteration. */
export type RequestFactory = (workerIndex: number, requestIndex: number) => Request | Promise<Request>;

/** Custom multi-request work for scenarios that issue more than one request. */
export type ScenarioWork = (workerIndex: number, requestIndex: number) => Promise<{ ok: boolean }>;

export interface RequestScenarioOptions {
	/** Display name for the result row; no `c=` prefix is added. */
	name: string;
	concurrency: number;
	warmupMs: number;
	durationMs: number;
	requestFor: RequestFactory;
	/** Success predicate applied after the body is drained; defaults to `response.ok`. */
	accept?: ((response: Response) => boolean) | undefined;
}

/**
 * One HTTP scenario at one concurrency: fetches `requestFor` per iteration,
 * drains the body and aggregates the run into a printable result row.
 */
export async function runRequestScenario(options: RequestScenarioOptions): Promise<HttpScenarioResult> {
	const run = await runHttpScenario({
		concurrency: options.concurrency,
		warmupMs: options.warmupMs,
		durationMs: options.durationMs,
		work: requestWork(options.requestFor, options.accept),
	});

	return scenarioResult(options.name, run, options.durationMs);
}

interface ScenarioMatrixEntryBase {
	name: string;
	/** Throughput unit for this row; defaults to the matrix unit. */
	unit?: string | undefined;
}

/** A matrix row: a single-request factory or custom multi-request work. */
export type ScenarioMatrixEntry =
	| (ScenarioMatrixEntryBase & { requestFor: RequestFactory; accept?: ((response: Response) => boolean) | undefined })
	| (ScenarioMatrixEntryBase & { work: ScenarioWork });

export interface ScenarioMatrixOptions {
	/** Suite tag in the progress header, e.g. `http` prints `[http] concurrency ...`. */
	suite: string;
	/** Default throughput unit for the log lines, e.g. `req/s`. */
	unit: string;
	concurrency: readonly number[];
	warmupMs: number;
	durationMs: number;
	scenarios: readonly ScenarioMatrixEntry[];
	/** Latency columns reported per log line; defaults to `p95`. */
	latency?: "p50" | "p95" | "both" | undefined;
	/** Decimal places for the logged latencies; defaults to 1. */
	latencyDigits?: number | undefined;
}

/**
 * Runs every scenario at every concurrency with the shared progress header and
 * per-scenario throughput/error log line; returns the rows for `printHttpResults`.
 */
export async function runScenarioMatrix(options: ScenarioMatrixOptions): Promise<HttpScenarioResult[]> {
	const results: HttpScenarioResult[] = [];
	for (const concurrency of options.concurrency) {
		console.log(`\n[${options.suite}] concurrency ${concurrency} (warmup ${options.warmupMs}ms, measure ${options.durationMs}ms)`);
		for (const scenario of options.scenarios) {
			const result = await runMatrixScenario(scenario, concurrency, options);
			results.push(result);
			const failureNote = result.errorRatePercent > 0 ? `, errors ${result.errorRatePercent.toFixed(1)}%` : "";
			console.log(
				`  ${scenario.name}: ${result.requestsPerSecond.toFixed(0)} ${scenario.unit ?? options.unit}, ${latencyText(result.stats, options)}${failureNote}`,
			);
		}
	}

	return results;
}

async function runMatrixScenario(
	scenario: ScenarioMatrixEntry,
	concurrency: number,
	options: ScenarioMatrixOptions,
): Promise<HttpScenarioResult> {
	if ("work" in scenario) {
		const run = await runHttpScenario({
			concurrency,
			warmupMs: options.warmupMs,
			durationMs: options.durationMs,
			work: scenario.work,
		});

		return scenarioResult(`c=${concurrency} ${scenario.name}`, run, options.durationMs);
	}

	return runRequestScenario({
		name: `c=${concurrency} ${scenario.name}`,
		concurrency,
		warmupMs: options.warmupMs,
		durationMs: options.durationMs,
		requestFor: scenario.requestFor,
		accept: scenario.accept,
	});
}

/** Wraps one request into a load sample: fetch, drain, accept, never throw. */
function requestWork(requestFor: RequestFactory, accept: ((response: Response) => boolean) | undefined): ScenarioWork {
	return async (workerIndex, requestIndex) => {
		try {
			const response = await fetch(await requestFor(workerIndex, requestIndex));
			const ok = accept ? accept(response) : response.ok;
			await response.arrayBuffer();

			return { ok };
		} catch {
			return { ok: false };
		}
	};
}

function latencyText(stats: LatencyStats, options: Pick<ScenarioMatrixOptions, "latency" | "latencyDigits">): string {
	const digits = options.latencyDigits ?? 1;
	if (options.latency === "p50") return `p50 ${stats.p50Ms.toFixed(digits)}ms`;
	if (options.latency === "both") return `p50 ${stats.p50Ms.toFixed(digits)}ms, p95 ${stats.p95Ms.toFixed(digits)}ms`;

	return `p95 ${stats.p95Ms.toFixed(digits)}ms`;
}

/** Aggregates one scenario run into a printable/JSON result row under an explicit name. */
function scenarioResult(name: string, run: HttpScenarioRun, durationMs: number): HttpScenarioResult {
	const stats = summarizeLatencies(run.latencies);

	return {
		name,
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
			...statCells(result.stats),
			String(result.stats.count),
		]),
	);
}

/** p50/p95/p99/max cells shared by the micro and HTTP result tables. */
function statCells(stats: LatencyStats): [string, string, string, string] {
	return [fmtMs(stats.p50Ms), fmtMs(stats.p95Ms), fmtMs(stats.p99Ms), fmtMs(stats.maxMs)];
}
