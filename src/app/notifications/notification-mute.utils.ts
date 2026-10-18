/**
 * The notification types a profile has muted, from the comma-separated preference value. Blanks and repeats are
 * dropped, so a stored `"system, system,"` reads as `["system"]`.
 */
export function parseMutedNotificationTypes(value: string | null | undefined): string[] {
	if (!value) return [];

	return [
		...new Set(
			value
				.split(",")
				.map((type) => type.trim())
				.filter((type) => type.length > 0),
		),
	];
}
