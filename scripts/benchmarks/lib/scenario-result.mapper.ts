import type { HttpScenarioResult, LatencyStats } from "benchkit";

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
 * Builds a printable result row with explicit numerators/denominators. Suites
 * differ in whether throughput counts every request or only successes, so the
 * caller passes the exact counts instead of the helper inferring them.
 */
export function toScenarioResult(input: ScenarioResultInput): HttpScenarioResult {
	return {
		name: input.name,
		stats: input.stats,
		requestsPerSecond: input.throughputCount / (input.elapsedMs / 1000),
		errorRatePercent: input.total > 0 ? (input.errorCount / input.total) * 100 : 0,
	};
}
