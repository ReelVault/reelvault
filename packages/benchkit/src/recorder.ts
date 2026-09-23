import { summarizeLatencies } from "./stats";

/** Per-operation label → raw latencies + error count. */
export class Recorder {
	private readonly ops = new Map<string, { latencies: number[]; errors: number }>();

	private entry(label: string): { latencies: number[]; errors: number } {
		let op = this.ops.get(label);
		if (!op) {
			op = { latencies: [], errors: 0 };
			this.ops.set(label, op);
		}

		return op;
	}

	record(label: string, latencyMs: number, ok: boolean): void {
		const op = this.entry(label);
		op.latencies.push(latencyMs);
		if (!ok) op.errors++;
	}

	/** Counts a failure without a meaningful latency (e.g. aborted cycle). */
	recordError(label: string): void {
		this.entry(label).errors++;
	}

	summary(): Array<{ label: string; count: number; errors: number; p50: number; p95: number; p99: number; max: number }> {
		return [...this.ops.entries()].map(([label, op]) => {
			const stats = summarizeLatencies(op.latencies);

			return { label, count: stats.count, errors: op.errors, p50: stats.p50Ms, p95: stats.p95Ms, p99: stats.p99Ms, max: stats.maxMs };
		});
	}

	serialize(): Record<
		string,
		{ count: number; errors: number; meanMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }
	> {
		const out: Record<
			string,
			{ count: number; errors: number; meanMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }
		> = {};
		for (const [label, op] of this.ops) {
			const stats = summarizeLatencies(op.latencies);
			out[label] = {
				count: stats.count,
				errors: op.errors,
				meanMs: stats.meanMs,
				p50Ms: stats.p50Ms,
				p95Ms: stats.p95Ms,
				p99Ms: stats.p99Ms,
				maxMs: stats.maxMs,
			};
		}

		return out;
	}
}
