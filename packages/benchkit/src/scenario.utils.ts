import { type LatencyStats, summarizeLatencies } from "./latency.utils";
import { runLoadWindow } from "./load.utils";
import { metric, type TaskMetrics } from "./metrics.utils";
import { latencyCells, printTable } from "./report.utils";

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

/** Custom work for scenarios that issue more than one request per iteration. */
export type ScenarioWork = (workerIndex: number, requestIndex: number) => Promise<{ ok: boolean }>;

/** Builds the request issued once per load-window iteration. */
export type RequestFactory = (workerIndex: number, requestIndex: number) => Request | Promise<Request>;

export interface HttpScenarioOptions {
	concurrency: number;
	warmupMs: number;
	durationMs: number;
	work: ScenarioWork;
}

/** Windowed load for one scenario, aggregated the way the suites report: post-warmup, success-only latencies. */
export async function runHttpScenario(options: HttpScenarioOptions): Promise<HttpScenarioRun> {
	const run = await runLoadWindow(options);

	return { latencies: run.successLatencies, successes: run.successes, requests: run.requests };
}

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
	return toScenarioResult({
		name,
		stats: summarizeLatencies(run.latencies),
		throughputCount: run.successes,
		elapsedMs: durationMs,
		errorCount: run.requests - run.successes,
		total: run.requests,
	});
}

export interface ScenarioResultInput {
	name: string;
	stats: LatencyStats;
	/** Numerator of requests/second — what the run counted as throughput (all requests or successes only). */
	throughputCount: number;
	/** Denominator of requests/second, in milliseconds. */
	elapsedMs: number;
	/** Numerator of the error rate. */
	errorCount: number;
	/** Denominator of the error rate. */
	total: number;
}

/**
 * A result row from explicit counts, for loops that do not go through a load window (byte
 * throughput, multi-step flows). Whether throughput counts every request or only the successes is the
 * caller's decision, so it passes the exact numerators and denominators.
 */
export function toScenarioResult(input: ScenarioResultInput): HttpScenarioResult {
	return {
		name: input.name,
		stats: input.stats,
		requestsPerSecond: input.throughputCount / (input.elapsedMs / 1000),
		errorRatePercent: input.total > 0 ? (input.errorCount / input.total) * 100 : 0,
	};
}

/** A named request builder that takes the suite's context (server handle, ids, identities). */
export interface NamedScenario<C> {
	name: string;
	builder: (context: C, workerIndex: number, requestIndex: number) => Request;
}

export interface ScenarioEntryOptions<C, S extends NamedScenario<C>> {
	/** Success predicate shared by the request entries; defaults to `response.ok`. */
	accept?: ((response: Response) => boolean) | undefined;
	/** Multi-request work replacing `builder` for specific scenarios (e.g. write/undo pairs). */
	workFor?: ((scenario: S, context: C) => ScenarioWork | undefined) | undefined;
}

/** Binds a suite's context to its named request builders: the matrix entries for `runScenarioMatrix`. */
export function toScenarioEntries<C, S extends NamedScenario<C>>(
	scenarios: readonly S[],
	context: C,
	options: ScenarioEntryOptions<C, S> = {},
): ScenarioMatrixEntry[] {
	return scenarios.map((scenario) => {
		const work = options.workFor?.(scenario, context);
		if (work) return { name: scenario.name, work };

		return {
			name: scenario.name,
			requestFor: (workerIndex, requestIndex) => scenario.builder(context, workerIndex, requestIndex),
			...(options.accept ? { accept: options.accept } : {}),
		};
	});
}

/** A JSON mutation request; the content type is set only when there is a body. */
export function jsonRequest(
	url: string,
	method: "POST" | "PUT" | "PATCH" | "DELETE",
	headers: Record<string, string>,
	body?: unknown,
): Request {
	return new Request(url, {
		method,
		headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

/** A string field of an untyped JSON payload (`{ id: "…" }`), or undefined. */
export function stringField(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null || !(key in value)) return undefined;

	const field: unknown = Reflect.get(value, key);

	return typeof field === "string" ? field : undefined;
}

export function printHttpResults(results: readonly HttpScenarioResult[]): void {
	printTable(
		"Results (successful responses only; higher req/s is better)",
		["scenario", "req/s", "errors", "p50", "p95", "p99", "max", "samples"],
		results.map((result) => [
			result.name,
			result.requestsPerSecond.toFixed(1),
			`${result.errorRatePercent.toFixed(1)}%`,
			...latencyCells(result.stats),
			String(result.stats.count),
		]),
	);
}

/**
 * Flattens scenario rows into baseline-comparable task metrics: throughput
 * (higher is better) and p95 latency (lower is better) per row.
 */
export function httpScenarioMetrics(results: readonly HttpScenarioResult[]): TaskMetrics {
	const metrics: TaskMetrics = {};
	for (const result of results) {
		metrics[`${result.name} req/s`] = metric(result.requestsPerSecond, true);
		metrics[`${result.name} p95 ms`] = metric(result.stats.p95Ms, false);
	}

	return metrics;
}
