/** True for plain JSON-like objects; false for arrays, null, and primitives. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for `null` and `undefined` — the two values a missing field can carry. */
export function isNullish(value: unknown): value is null | undefined {
	return value === null || value === undefined;
}

/** Type guard that filters out `null` and `undefined` values. */
export function isNotNullish<T>(value: T | null | undefined): value is T {
	return !isNullish(value);
}

/** Returns a new object with only the keys whose values are not `null` or `undefined`. */
export function pickDefined(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		const value = obj[key];
		if (!isNullish(value)) {
			result[key] = value;
		}
	}

	return result;
}

/**
 * Folds a string for case-insensitive comparison: trimmed and lowercased, with
 * an optional Unicode normalization form applied in between.
 */
export function normalizeCase(value: string, form?: "NFC" | "NFD" | "NFKC" | "NFKD"): string {
	const trimmed = value.trim();

	return (form === undefined ? trimmed : trimmed.normalize(form)).toLowerCase();
}

/** Trims whitespace and lowercases a string — the standard normalization for case-insensitive comparisons. */
export function normalizeLower(value: string): string {
	return normalizeCase(value);
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
 * The boolean a raw string carries, or undefined when the string is not a
 * boolean at all: "true"/"1" → true, "false"/"0" → false.
 *
 * The single rule behind both the query-parameter coercion and the admin
 * settings codec, so a flag cannot mean two different things depending on
 * where it was written.
 */
export function parseBooleanToken(raw: string): boolean | undefined {
	const normalized = raw.trim().toLowerCase();
	if (normalized === "true" || normalized === "1") return true;
	if (normalized === "false" || normalized === "0") return false;

	return undefined;
}

/**
 * Coerces a query-parameter value (which may arrive as a string `"true"`/`"false"`
 * or as a boolean) into a boolean. Unrecognized values and empty strings → `false`.
 */
export function coerceBoolean(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return parseBooleanToken(value) ?? false;

	return Boolean(value);
}
