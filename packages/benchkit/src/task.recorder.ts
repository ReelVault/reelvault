import { type LatencyStats, summarizeLatencies } from "./latency.utils";

interface RecorderEntry {
	latencies: number[];
	errors: number;
}

/** Per-operation label → raw latencies + error count. */
export class Recorder {
	private readonly ops = new Map<string, RecorderEntry>();

	private entry(label: string): RecorderEntry {
		let op = this.ops.get(label);
		if (!op) {
			op = { latencies: [], errors: 0 };
			this.ops.set(label, op);
		}

		return op;
	}

	private statsFor(op: RecorderEntry): LatencyStats {
		return summarizeLatencies(op.latencies);
	}

	record(label: string, latencyMs: number, ok: boolean): void {
		const op = this.entry(label);
		op.latencies.push(latencyMs);
		if (!ok) op.errors++;
	}

	/** Times one operation under `label`; it reports success, and a thrown error counts as a failure. */
	async time(label: string, operation: () => Promise<boolean>): Promise<void> {
		const startedAt = performance.now();
		let ok = false;
		try {
			ok = await operation();
		} catch {
			ok = false;
		}

		this.record(label, performance.now() - startedAt, ok);
	}

	/** Counts a failure without a meaningful latency (e.g. aborted cycle). */
	recordError(label: string): void {
		this.entry(label).errors++;
	}

	summary(): Array<{ label: string; count: number; errors: number; p50: number; p95: number; p99: number; max: number }> {
		return [...this.ops.entries()].map(([label, op]) => {
			const stats = this.statsFor(op);

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
			const stats = this.statsFor(op);
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
