const SEQUEL_DIGIT_PATTERN = /\b(?:part|pt|vol|volume|chapter|czesc|faza)?\s*([1-9]|1[0-9]|20)\b$/i;

/**
 * Extracts a normalized sequel number from the end of a title (e.g. "iron man 3" -> "3", "dune part 2" -> "2").
 */
export function extractSequelNumber(normalizedTitle: string): string | null {
	return normalizedTitle.match(SEQUEL_DIGIT_PATTERN)?.[1] ?? null;
}

/**
 * Detects whether there is a mismatch in sequel numbers between query and candidate.
 * e.g. "Iron Man" (no sequel) vs "Iron Man 3" (sequel 3) -> true (mismatch!)
 * e.g. "Iron Man 2" vs "Iron Man 3" -> true (mismatch!)
 * e.g. "Iron Man" vs "Iron Man 1" -> false (compatible)
 * e.g. "Iron Man 2" vs "Iron Man 2" -> false (compatible)
 */
export function sequelMismatch(sequelA: string | null, sequelB: string | null): boolean {
	if (!(sequelA || sequelB)) return false;

	if (sequelA === sequelB) return false;

	if ((!sequelA && sequelB === "1") || (sequelA === "1" && !sequelB)) return false;

	return true;
}
