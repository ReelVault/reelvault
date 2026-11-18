/** The dedupe key of a whole-library scan or one of its paths. */
export function buildLibraryScanDedupeKey(libraryId: string, pathId?: string | null): string {
	return `${libraryId}:${pathId ?? "all"}`;
}

/** Appended to a scan dedupe key for the catch-up pass queued when a scan is already running. */
export const LIBRARY_SCAN_CATCH_UP_SUFFIX = ":catch-up";
