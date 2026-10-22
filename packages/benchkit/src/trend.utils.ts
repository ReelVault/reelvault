/**
 * Trend checks over a series of samples taken after identical rounds of work — the leak test for a
 * process whose garbage collector cannot be forced from outside. A before/after delta is GC noise; a
 * slope that keeps climbing without levelling off is the signal.
 */

/** Least-squares slope of the samples against their index (units per round). */
export function linearSlope(samples: readonly number[]): number {
	const n = samples.length;
	if (n < 2) return 0;

	const meanX = (n - 1) / 2;
	let meanY = 0;
	for (const sample of samples) meanY += sample / n;
	let numerator = 0;
	let denominator = 0;
	for (const [index, sample] of samples.entries()) {
		numerator += (index - meanX) * (sample - meanY);
		denominator += (index - meanX) ** 2;
	}

	return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Whether the climb has stopped: the slope of the last third of the series is at most
 * `maxSlopePerRound`. Growth while caches fill is fine as long as it ends; a band around the
 * absolute level would hide a steady leak that is small next to the process's total size. A series
 * too short to have two samples per third counts as level.
 */
export function levelsOff(samples: readonly number[], maxSlopePerRound: number): boolean {
	const third = Math.floor(samples.length / 3);
	if (third < 2) return true;

	return linearSlope(samples.slice(-third)) <= maxSlopePerRound;
}

export interface GrowthVerdict {
	/** Growth per round over the whole series, from `linearSlope`. */
	slope: number;
	levelled: boolean;
	/** The series grew faster than the threshold and was still growing at the end. */
	growing: boolean;
}

/** Sustained growth: a slope above `maxSlopePerRound` that is still there in the last third of the series. */
export function growthVerdict(samples: readonly number[], maxSlopePerRound: number): GrowthVerdict {
	const slope = linearSlope(samples);
	const levelled = levelsOff(samples, maxSlopePerRound);

	return { slope, levelled, growing: slope > maxSlopePerRound && !levelled };
}
