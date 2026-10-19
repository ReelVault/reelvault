import { normalizeForFuzzy, WHITESPACE_COLLAPSE } from "./normalize.utils";

/**
 * Levenshtein distance with a banded early exit: returns `null` as soon as the
 * distance provably exceeds `maxDistance`, so a scan over many candidates pays
 * (at most) a thin diagonal band of the matrix per row.
 */
export function boundedLevenshtein(source: string, target: string, maxDistance: number): number | null {
	if (source === target) return 0;

	if (Math.abs(source.length - target.length) > maxDistance) return null;

	// Ensure target is the shorter string to minimize row memory and inner loop iterations.
	const s = source.length >= target.length ? source : target;
	const t = source.length >= target.length ? target : source;
	const sLen = s.length;
	const tLen = t.length;

	let v0: number[] = Array.from({ length: tLen + 1 });
	let v1: number[] = Array.from({ length: tLen + 1 });
	for (let j = 0; j <= tLen; j++) {
		v0[j] = j;
	}

	for (let i = 1; i <= sLen; i++) {
		v1[0] = i;
		const rowMinimum = nextDistanceRow(v0, v1, s.charCodeAt(i - 1), t, tLen);

		if (rowMinimum > maxDistance) return null;

		const temp = v0;
		v0 = v1;
		v1 = temp;
	}

	const distance = v0[tLen];

	return distance !== undefined && distance <= maxDistance ? distance : null;
}

/** One row of the distance matrix; returns the row's smallest distance. */
function nextDistanceRow(v0: number[], v1: number[], sCharCode: number, t: string, tLen: number): number {
	let rowMinimum = v1[0] ?? 0;

	for (let j = 1; j <= tLen; j++) {
		const substitution = (v0[j - 1] ?? 0) + (sCharCode === t.charCodeAt(j - 1) ? 0 : 1);
		const value = Math.min((v0[j] ?? 0) + 1, (v1[j - 1] ?? 0) + 1, substitution);
		v1[j] = value;
		if (value < rowMinimum) rowMinimum = value;
	}

	return rowMinimum;
}

/**
 * Best distance between the (single) query token and any word of the title.
 * `null` means the title cannot match within the accepted distance.
 */
export function fuzzyTitleDistance(queryToken: string, title: string, maxDistance: number): number | null {
	const query = normalizeForFuzzy(queryToken);
	if (!query) return null;

	const words = normalizeForFuzzy(title).split(WHITESPACE_COLLAPSE).filter(Boolean);
	let best: number | null = null;
	for (const word of words) {
		if (word === query) return 0;

		// Contained words (prefix-stemmed queries, "war" in "Warsaw") are near
		// hits priced by the length gap — but only while within the threshold.
		if (word.includes(query) || query.includes(word)) {
			const gap = Math.abs(word.length - query.length);
			if (gap <= maxDistance && (best === null || gap < best)) best = gap;

			continue;
		}

		const distance = boundedLevenshtein(query, word, maxDistance);
		if (distance !== null && (best === null || distance < best)) best = distance;
	}

	return best;
}
