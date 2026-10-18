export interface LoadSample {
	/** Whether one unit of work succeeded (e.g. HTTP 2xx). */
	ok: boolean;
	/** Per-request counters (bytes, segments, ...) summed into the result. */
	metrics?: Record<string, number> | undefined;
}

export interface LoadWindowResult {
	/** Counted (post-warmup) requests. */
	requests: number;
	successes: number;
	failures: number;
	/** Post-warmup latencies of every counted request, success or not. */
	latencies: number[];
	/** Post-warmup latencies of successful requests only. */
	successLatencies: number[];
	/** Summed per-request counters. */
	metrics: Record<string, number>;
}

export interface LoadWindowOptions {
	concurrency: number;
	/** Discard every request that finishes before `startedAt + warmupMs`. */
	warmupMs: number;
	/** Keep working until `startedAt + warmupMs + durationMs` (closed-loop workers). */
	durationMs: number;
	/** Sum metrics from the very first request instead of after warmup —
	 * throughput suites that divide total bytes by the measure window only. */
	accumulateFromStart?: boolean;
	/** Performs one unit of work; thrown errors count as a failed sample. */
	work: (workerIndex: number, requestIndex: number) => Promise<LoadSample>;
}

/**
 * Closed-loop load window: `concurrency` workers loop until the deadline,
 * measuring each request and discarding samples inside the warmup window.
 * Latency is measured around `work` — do the per-request setup (form building,
 * target picking) inside it when that cost should be part of the measurement.
 */
export async function runLoadWindow(options: LoadWindowOptions): Promise<LoadWindowResult> {
	const latencies: number[] = [];
	const successLatencies: number[] = [];
	const metrics: Record<string, number> = {};
	let requests = 0;
	let successes = 0;
	let failures = 0;
	const startedAt = performance.now();
	const warmupEndsAt = startedAt + options.warmupMs;
	const runDeadline = startedAt + options.warmupMs + options.durationMs;

	const accumulate = (sample: LoadSample): void => {
		if (!sample.metrics) return;

		for (const [key, value] of Object.entries(sample.metrics)) {
			metrics[key] = (metrics[key] ?? 0) + value;
		}
	};

	const worker = async (workerIndex: number): Promise<void> => {
		let requestIndex = 0;
		while (performance.now() < runDeadline) {
			const requestStartedAt = performance.now();
			let sample: LoadSample;
			try {
				sample = await options.work(workerIndex, requestIndex);
			} catch {
				sample = { ok: false };
			}

			const finishedAt = performance.now();
			if (options.accumulateFromStart) accumulate(sample);

			if (finishedAt >= warmupEndsAt) {
				requests++;
				const latencyMs = finishedAt - requestStartedAt;
				latencies.push(latencyMs);
				if (sample.ok) {
					successes++;
					successLatencies.push(latencyMs);
				} else {
					failures++;
				}

				if (!options.accumulateFromStart) accumulate(sample);
			}

			requestIndex++;
		}
	};

	await Promise.all(Array.from({ length: options.concurrency }, (_, workerIndex) => worker(workerIndex)));

	return { requests, successes, failures, latencies, successLatencies, metrics };
}

/** Extracts segment file names from an HLS media playlist (.m4s / .ts lines). */
export function parseSegments(playlist: string): string[] {
	return playlist
		.split("\n")
		.filter((line) => line.trimEnd().endsWith(".m4s") || line.trimEnd().endsWith(".ts"))
		.map((line) => line.trim().split("/").pop() ?? "");
}
