/** Latency statistics over a sample of request/operation times in milliseconds. */
export interface LatencyStats {
	count: number;
	meanMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
}

/** Nearest-rank percentile of an ascending sample. */
function rankOf(sorted: readonly number[], percent: number): number {
	if (sorted.length === 0) return 0;

	return sorted[Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)] ?? 0;
}

/** Nearest-rank percentile of an unordered sample. */
export function percentile(values: readonly number[], percent: number): number {
	return rankOf(
		values.toSorted((left, right) => left - right),
		percent,
	);
}

/** Count, mean, p50/p95/p99 and max of a sample; one sort serves every percentile. */
export function summarizeLatencies(timesMs: readonly number[]): LatencyStats {
	const count = timesMs.length;
	if (count === 0) return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };

	const sorted = timesMs.toSorted((left, right) => left - right);
	let total = 0;
	for (const value of sorted) total += value;

	return {
		count,
		meanMs: total / count,
		p50Ms: rankOf(sorted, 50),
		p95Ms: rankOf(sorted, 95),
		p99Ms: rankOf(sorted, 99),
		maxMs: sorted[count - 1] ?? 0,
	};
}
