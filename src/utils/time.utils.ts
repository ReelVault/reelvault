/**
 * Parses an FFmpeg-style colon-separated time string (`[[HH:]MM:]SS.mmm`) into seconds.
 *
 * `parseFloat("01:30:45.5")` would stop at the first colon; this handles the full
 * HH:MM:SS.mmm format by splitting on `:` and weighting each part by 60^n.
 */
export function parseColonSeparatedSeconds(value: string): number {
	const parts = value.split(":");
	let total = 0;
	for (const partStr of parts) {
		if (!partStr) return Number.NaN;

		const part = Number.parseFloat(partStr);
		if (Number.isNaN(part)) return Number.NaN;

		total = total * 60 + part;
	}

	return total;
}

/** Converts a `Date`, ISO string, or numeric timestamp to an ISO-8601 string. */
export function serializeDate(value: Date | string | number): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The `YYYY-MM-DD` day a date falls on. Local time by default (a log file is
 * named after the day it was written); `utc` names it after the UTC day, which
 * is what a cross-machine export wants.
 */
export function formatDateOnly(date: Date, timeZone: "local" | "utc" = "local"): string {
	if (timeZone === "utc") return date.toISOString().slice(0, 10);

	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");

	return `${year}-${month}-${day}`;
}

/** Returns `true` if the given expiry date is at or before the current time. */
export function isExpired(expiresAt: Date, now?: number): boolean {
	return expiresAt.getTime() <= (now ?? Date.now());
}
