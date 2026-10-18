/** Latency statistics over a sample of request/operation times in milliseconds. */
export interface LatencyStats {
	count: number;
	meanMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	maxMs: number;
}

export function percentile(values: readonly number[], percent: number): number {
	if (values.length === 0) return 0;

	const sorted = values.toSorted((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);

	return sorted[index] ?? 0;
}

export function summarizeLatencies(timesMs: readonly number[]): LatencyStats {
	const count = timesMs.length;
	if (count === 0) return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };

	let total = 0;
	let max = 0;
	for (const value of timesMs) {
		total += value;
		if (value > max) max = value;
	}

	return {
		count,
		meanMs: total / count,
		p50Ms: percentile(timesMs, 50),
		p95Ms: percentile(timesMs, 95),
		p99Ms: percentile(timesMs, 99),
		maxMs: max,
	};
}
