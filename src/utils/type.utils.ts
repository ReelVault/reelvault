/** True for plain JSON-like objects; false for arrays, null, and primitives. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a new object with only the keys whose values are not `null` or `undefined`. */
export function pickDefined(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		const value = obj[key];
		if (value != null) {
			result[key] = value;
		}
	}

	return result;
}

/** Trims whitespace and lowercases a string — the standard normalization for case-insensitive comparisons. */
export function normalizeLower(value: string): string {
	return value.trim().toLowerCase();
}

/** Maps a library type string (`"movies"` / `"tv"`) to the canonical media type. */
export function mapLibraryType(libraryType: string): "movie" | "tv_show" {
	return libraryType === "movies" ? "movie" : "tv_show";
}

/** True when `value` is a non-empty string after trimming. */
export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** True when `value` is a finite number (not NaN, not Infinity). */
export function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Coerces a query-parameter value (which may arrive as a string `"true"`/`"false"`
 * or as a boolean) into a boolean. Empty strings and `undefined` → `false`.
 */
export function coerceBoolean(value: unknown): boolean {
	if (typeof value === "string") return value.toLowerCase() === "true";

	return Boolean(value);
}
