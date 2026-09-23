import { percentile } from "./stats";

export const DEFAULT_MIN_DELTA_PERCENT = 3;

export const MIN_SAMPLES_FOR_VERDICT = 8;
/** Two-sided z threshold for p < 0.05 (normal approximation). */
const Z_SIGNIFICANT = 1.96;

export type Verdict = "faster" | "slower" | "unchanged" | "noisy";

export interface BaselineEntry {
	kind: "bench";
	file: string;
	name: string;
	/** Raw per-iteration samples (ms) — the input for the significance test. */
	samples: number[];
	p50Ms: number;
}

export interface BaselineFile {
	schema: "benchkit-baseline/v1";
	generatedAt: string;
	entries: BaselineEntry[];
}

export interface BaselineComparison {
	file: string;
	name: string;
	verdict: Verdict;
	/** Median change vs the baseline, percent (negative = faster). */
	deltaPercent: number;
	samples: number;
}

/**
 * Mann–Whitney U z-score (normal approximation, tie-corrected) for current
 * samples vs baseline samples. Latency distributions are not normal, so the
 * test runs on ranks, not means.
 */
export function mannWhitneyZ(current: readonly number[], baseline: readonly number[]): number {
	const n1 = current.length;
	const n2 = baseline.length;
	if (n1 === 0 || n2 === 0) return 0;

	const tagged: Array<{ value: number; fromCurrent: boolean }> = [
		...current.map((value) => ({ value, fromCurrent: true })),
		...baseline.map((value) => ({ value, fromCurrent: false })),
	];
	tagged.sort((left, right) => left.value - right.value);

	let rankSumCurrent = 0;
	let i = 0;
	while (i < tagged.length) {
		const value = tagged[i]?.value;
		let j = i;
		while (j + 1 < tagged.length && tagged[j + 1]?.value === value) j++;

		const averageRank = (i + j) / 2 + 1;
		for (let k = i; k <= j; k++) {
			const item = tagged[k];
			if (item?.fromCurrent) rankSumCurrent += averageRank;
		}

		i = j + 1;
	}

	const u1 = rankSumCurrent - (n1 * (n1 + 1)) / 2;
	const mu = (n1 * n2) / 2;

	let tieSum = 0;
	let run = 1;
	for (let k = 1; k < tagged.length; k++) {
		const value = tagged[k]?.value;
		const previous = tagged[k - 1]?.value;
		if (value === previous) {
			run++;
		} else {
			tieSum += run ** 3 - run;
			run = 1;
		}
	}

	tieSum += run ** 3 - run;

	const n = n1 + n2;
	const variance = ((n1 * n2) / 12) * ((n ** 3 - n - tieSum) / (n ** 2 - n));
	if (variance <= 0) return 0;

	return (u1 - mu) / Math.sqrt(variance);
}

export interface BaselineCompareOptions {
	/** Deltas below this magnitude count as unchanged regardless of significance. */
	minDeltaPercent?: number;
}

/**
 * Compares one current unit against its baseline counterpart:
 *   - |delta| < minDeltaPercent            → unchanged (below practical relevance),
 *   - |delta| ≥ minDelta but not significant → noisy (too scattered to claim),
 *   - significant and negative delta        → faster, positive → slower.
 */
export function compareBaselineEntry(
	entry: BaselineEntry,
	baseline: BaselineEntry,
	options: BaselineCompareOptions = {},
): BaselineComparison {
	const minDeltaPercent = options.minDeltaPercent ?? DEFAULT_MIN_DELTA_PERCENT;
	const baseMedian = percentile(baseline.samples, 50);
	const currentMedian = percentile(entry.samples, 50);
	const deltaPercent = baseMedian !== 0 ? ((currentMedian - baseMedian) / baseMedian) * 100 : 0;

	let verdict: Verdict;
	if (entry.samples.length < MIN_SAMPLES_FOR_VERDICT || baseline.samples.length < MIN_SAMPLES_FOR_VERDICT) {
		verdict = "noisy";
	} else if (Math.abs(deltaPercent) < minDeltaPercent) {
		verdict = "unchanged";
	} else if (Math.abs(mannWhitneyZ(entry.samples, baseline.samples)) < Z_SIGNIFICANT) {
		verdict = "noisy";
	} else {
		verdict = deltaPercent < 0 ? "faster" : "slower";
	}

	return { file: entry.file, name: entry.name, verdict, deltaPercent, samples: entry.samples.length };
}

/** Matches current entries against baseline entries by `file` + `name`. */
export function compareWithBaseline(
	current: readonly BaselineEntry[],
	baseline: readonly BaselineEntry[],
	options: BaselineCompareOptions = {},
): { comparisons: BaselineComparison[]; missingInBaseline: number } {
	const byKey = new Map(baseline.map((entry) => [`${entry.file}/${entry.name}`, entry]));
	const comparisons: BaselineComparison[] = [];
	let missingInBaseline = 0;

	for (const entry of current) {
		const match = byKey.get(`${entry.file}/${entry.name}`);
		if (!match) {
			missingInBaseline++;
			continue;
		}

		comparisons.push(compareBaselineEntry(entry, match, options));
	}

	return { comparisons, missingInBaseline };
}
