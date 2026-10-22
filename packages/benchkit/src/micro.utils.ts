import { summarizeLatencies } from "./latency.utils";
import { latencyCells, printTable } from "./report.utils";

export interface MicroBenchmarkResult {
	name: string;
	timesMs: number[];
	/** Number of rows when the measured operation returns an array (SQL benchmarks). */
	rows?: number;
}

export interface MicroOptions {
	warmup?: number;
	iterations?: number;
}

/** Adds the measured operation's row count when it produced an array. */
function withRows(result: MicroBenchmarkResult, produced: unknown): MicroBenchmarkResult {
	return Array.isArray(produced) ? { ...result, rows: produced.length } : result;
}

/** Runs `operation` `warmup` times (default 10), then times `iterations` runs (default 100). */
export function measure(name: string, operation: (iteration: number) => unknown, options: MicroOptions = {}): MicroBenchmarkResult {
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

/** Runs async `operation` `warmup` times (default 5), then times `iterations` runs (default 50). */
export async function measureAsync(
	name: string,
	operation: (iteration: number) => Promise<unknown>,
	options: MicroOptions = {},
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

/** `measure` plus the row count of one extra call, for operations that return a result set. */
export function benchmark(name: string, operation: (iteration: number) => unknown, options: MicroOptions = {}): MicroBenchmarkResult {
	return withRows(measure(name, operation, options), operation(-1));
}

/** `measureAsync` plus the row count of one extra call, for operations that return a result set. */
export async function benchmarkAsync(
	name: string,
	operation: (iteration: number) => Promise<unknown>,
	options: MicroOptions = {},
): Promise<MicroBenchmarkResult> {
	return withRows(await measureAsync(name, operation, options), await operation(-1));
}

export function printMicroResults(results: readonly MicroBenchmarkResult[], title = "Results (lower is better)"): void {
	printTable(
		title,
		["benchmark", "p50", "p95", "p99", "max", "rows"],
		results.map((result) => [
			result.name,
			...latencyCells(summarizeLatencies(result.timesMs)),
			result.rows === undefined ? "-" : String(result.rows),
		]),
	);
}
