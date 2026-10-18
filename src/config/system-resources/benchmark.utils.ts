import { DomainError } from "@/utils/domain.errors";
import { clamp } from "@/utils/math.utils";

// Single-core score of a modern desktop core in benchmark iterations per ms
// (see runBenchmarkRound). Calibrated on Zen-class hardware; older server CPUs
// (Xeon E5 class, ARM SBCs) measure roughly 0.35-0.6 of it.
const SPEED_REFERENCE_ITERATIONS_PER_MS = 260_000;
const SPEED_FACTOR_MIN = 0.35;
const SPEED_FACTOR_MAX = 1.5;

export function clampSpeedFactor(factor: number): number {
	return clamp(factor, SPEED_FACTOR_MIN, SPEED_FACTOR_MAX);
}

/** Runs a short CPU-bound loop and scores single-core speed against a modern desktop core. */
export function measureSpeedFactor(): number {
	const warmup = runBenchmarkRound(50_000);
	let iterations = Math.max(50_000, Math.floor((warmup.iterations / Math.max(warmup.elapsedMs, 0.1)) * 8));
	iterations = Math.min(iterations, 8_000_000);
	let best = Number.POSITIVE_INFINITY;
	for (let round = 0; round < 2; round++) {
		const sample = runBenchmarkRound(iterations);
		best = Math.min(best, sample.elapsedMs);
	}

	const scorePerMs = iterations / Math.max(best, 0.1);

	return clampSpeedFactor(scorePerMs / SPEED_REFERENCE_ITERATIONS_PER_MS);
}

function runBenchmarkRound(iterations: number): { iterations: number; elapsedMs: number } {
	const start = performance.now();
	let acc = 0;
	for (let i = 1; i <= iterations; i++) {
		acc = (acc + Math.imul(i, 2654435761)) % 2147483647;
		// Keep string machinery inside the measured work — server workloads
		// are JSON/string-heavy, not pure integer math.
		if ((i & 8191) === 0) acc += i.toString().length;
	}

	// Defeat dead-code elimination in optimising runtimes.
	if (acc === -1) throw new DomainError("internal", "benchmark accumulator overflow", { code: "system_resources.benchmark_overflow" });

	return { iterations, elapsedMs: performance.now() - start };
}
