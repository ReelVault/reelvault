import { trimAndFilter, unique } from "@/utils/array.utils";

/**
 * The notification types a profile has muted, from the comma-separated preference value. Blanks and repeats are
 * dropped, so a stored `"system, system,"` reads as `["system"]`.
 */
export function parseMutedNotificationTypes(value: string | null | undefined): string[] {
	if (!value) return [];

	return unique(trimAndFilter(value.split(",")));
}
