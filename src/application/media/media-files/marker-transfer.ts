import type { CreateMediaMarker, MediaMarker } from "@reelvault/sdk/common";
import { CreateMediaMarkerSchema } from "@reelvault/sdk/common";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@/utils/errors";
import { isRecord } from "@/utils/type.utils";

/** Most markers one export or import handles; a larger one is refused rather than cut short. */
export const MARKER_TRANSFER_MAX_LINES = 50_000;

export interface MarkerImportEntry {
	mediaFileId: string;
	marker: CreateMediaMarker;
}

/** Marker fields an import line may carry; the server-owned id and timestamps are ignored. */
const IMPORT_FIELDS = ["type", "startSeconds", "endSeconds", "label", "source", "pluginId"] as const;

/** One marker per line, each carrying its media file id. Server-owned fields (id, timestamps) are left out. */
export function serializeMarkersNdjson(markers: readonly MediaMarker[]): string {
	if (markers.length === 0) return "";

	const lines = markers.map((marker) =>
		JSON.stringify({
			mediaFileId: marker.mediaFileId,
			type: marker.type,
			startSeconds: marker.startSeconds,
			endSeconds: marker.endSeconds,
			label: marker.label,
			source: marker.source,
			pluginId: marker.pluginId,
		}),
	);

	return `${lines.join("\n")}\n`;
}

function invalidLine(lineNumber: number, reason: string): ValidationError {
	return new ValidationError(`Marker line ${lineNumber} is invalid: ${reason}`, {
		code: "media.markers_import_invalid",
		params: { line: lineNumber, reason },
	});
}

function parseLine(line: string, lineNumber: number): unknown {
	try {
		return JSON.parse(line);
	} catch {
		throw invalidLine(lineNumber, "not_json");
	}
}

/**
 * Parses an NDJSON marker file. Any invalid line refuses the whole file, and the error names the
 * line, so nothing is written from a half-readable file.
 */
export function parseMarkersNdjson(text: string): MarkerImportEntry[] {
	const entries: MarkerImportEntry[] = [];

	for (const [index, raw] of text.split("\n").entries()) {
		const line = raw.trim();
		if (line === "") continue;

		const lineNumber = index + 1;
		if (entries.length >= MARKER_TRANSFER_MAX_LINES) {
			throw new ValidationError(`A marker import holds at most ${MARKER_TRANSFER_MAX_LINES} markers`, {
				code: "media.markers_import_too_large",
				params: { limit: MARKER_TRANSFER_MAX_LINES },
			});
		}

		const parsed = parseLine(line, lineNumber);
		if (!isRecord(parsed)) throw invalidLine(lineNumber, "not_an_object");

		const mediaFileId = parsed.mediaFileId;
		if (typeof mediaFileId !== "string" || mediaFileId.trim() === "") throw invalidLine(lineNumber, "media_file_id_missing");

		// Null means "not set" in an export (an unlabelled marker has `label: null`), so it is dropped, not sent.
		const candidate: Record<string, unknown> = {};
		for (const field of IMPORT_FIELDS) {
			const value = parsed[field];
			if (value !== undefined && value !== null) candidate[field] = value;
		}

		if (!Value.Check(CreateMediaMarkerSchema, candidate)) throw invalidLine(lineNumber, "invalid_marker");
		if (candidate.endSeconds < candidate.startSeconds) throw invalidLine(lineNumber, "end_before_start");

		entries.push({ mediaFileId: mediaFileId.trim(), marker: candidate });
	}

	return entries;
}

/** Markers per media file, in file order: each file's markers are replaced as one set. */
export function groupMarkersByMediaFile(entries: readonly MarkerImportEntry[]): Map<string, CreateMediaMarker[]> {
	const grouped = new Map<string, CreateMediaMarker[]>();
	for (const entry of entries) {
		const markers = grouped.get(entry.mediaFileId);
		if (markers) markers.push(entry.marker);
		else grouped.set(entry.mediaFileId, [entry.marker]);
	}

	return grouped;
}
