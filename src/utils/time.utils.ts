/**
 * Parses an FFmpeg-style colon-separated time string (`[[HH:]MM:]SS.mmm`) into seconds.
 *
 * `parseFloat("01:30:45.5")` would stop at the first colon; this handles the full
 * HH:MM:SS.mmm format by splitting on `:` and weighting each part by 60^n.
 */
export function parseColonSeparatedSeconds(value: string): number {
	const parts = value.split(":");
	let total = 0;
	for (let i = 0; i < parts.length; i++) {
		const partStr = parts[i];
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

/** Returns `true` if the given expiry date is at or before the current time. */
export function isExpired(expiresAt: Date, now?: number): boolean {
	return expiresAt.getTime() <= (now ?? Date.now());
}
