const YEAR_REGEX = /^\d{4}$/;

/** Strict 4-digit year text (an XML `<year>` or the date prefix at the call site). */
export function extractYear(value: string | undefined): number | undefined {
	return value && YEAR_REGEX.test(value) ? Number(value) : undefined;
}
