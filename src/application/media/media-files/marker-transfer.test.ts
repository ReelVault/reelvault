import { describe, expect, test } from "bun:test";
import type { MediaMarker } from "@reelvault/sdk/common";
import { groupMarkersByMediaFile, MARKER_TRANSFER_MAX_LINES, parseMarkersNdjson, serializeMarkersNdjson } from "./marker-transfer";

function marker(overrides: Partial<MediaMarker> = {}): MediaMarker {
	return {
		id: "marker-1",
		mediaFileId: "file-1",
		type: "intro",
		startSeconds: 0,
		endSeconds: 42.5,
		label: null,
		source: "manual",
		pluginId: null,
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		...overrides,
	};
}

function validationCode(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return (error as { code?: unknown }).code;
	}

	return undefined;
}

describe("marker NDJSON transfer", () => {
	test("serializes one marker per line without server-owned fields and reads it back", () => {
		const text = serializeMarkersNdjson([marker(), marker({ id: "marker-2", mediaFileId: "file-2", type: "credits", label: "Ending" })]);

		expect(text.endsWith("\n")).toBe(true);
		expect(text).not.toContain("createdAt");
		expect(text).not.toContain('"id"');

		const entries = parseMarkersNdjson(text);
		expect(entries).toEqual([
			{
				mediaFileId: "file-1",
				marker: { type: "intro", startSeconds: 0, endSeconds: 42.5, source: "manual" },
			},
			{
				mediaFileId: "file-2",
				marker: { type: "credits", startSeconds: 0, endSeconds: 42.5, label: "Ending", source: "manual" },
			},
		]);
	});

	test("an empty export is an empty file", () => {
		expect(serializeMarkersNdjson([])).toBe("");
		expect(parseMarkersNdjson("")).toEqual([]);
	});

	test("refuses the whole file when a line is invalid, naming the line", () => {
		const text = `${JSON.stringify({ mediaFileId: "file-1", type: "intro", startSeconds: 0, endSeconds: 5 })}\nnot json\n`;

		expect(validationCode(() => parseMarkersNdjson(text))).toBe("media.markers_import_invalid");
		expect(() => parseMarkersNdjson(text)).toThrow("Marker line 2 is invalid: not_json");
	});

	test("rejects a missing media file id, an unknown type and an end before the start", () => {
		expect(() => parseMarkersNdjson(JSON.stringify({ type: "intro", startSeconds: 0, endSeconds: 5 }))).toThrow("media_file_id_missing");
		expect(() => parseMarkersNdjson(JSON.stringify({ mediaFileId: "f", type: "ending", startSeconds: 0, endSeconds: 5 }))).toThrow(
			"invalid_marker",
		);
		expect(() => parseMarkersNdjson(JSON.stringify({ mediaFileId: "f", type: "intro", startSeconds: 9, endSeconds: 5 }))).toThrow(
			"end_before_start",
		);
	});

	test("nulls from an export mean unset, so they do not fail the import", () => {
		const [entry] = parseMarkersNdjson(
			JSON.stringify({ mediaFileId: "f", type: "recap", startSeconds: 1, endSeconds: 2, label: null, pluginId: null }),
		);

		expect(entry?.marker).toEqual({ type: "recap", startSeconds: 1, endSeconds: 2 });
	});

	test("groups markers by media file in file order", () => {
		const entries = parseMarkersNdjson(
			[
				JSON.stringify({ mediaFileId: "a", type: "intro", startSeconds: 0, endSeconds: 1 }),
				JSON.stringify({ mediaFileId: "b", type: "recap", startSeconds: 0, endSeconds: 1 }),
				JSON.stringify({ mediaFileId: "a", type: "credits", startSeconds: 2, endSeconds: 3 }),
			].join("\n"),
		);

		const grouped = groupMarkersByMediaFile(entries);

		expect([...grouped.keys()]).toEqual(["a", "b"]);
		expect(grouped.get("a")?.map((item) => item.type)).toEqual(["intro", "credits"]);
	});

	test("refuses a file past the line cap", () => {
		const line = JSON.stringify({ mediaFileId: "f", type: "intro", startSeconds: 0, endSeconds: 1 });
		const text = Array.from({ length: MARKER_TRANSFER_MAX_LINES + 1 }, () => line).join("\n");

		expect(validationCode(() => parseMarkersNdjson(text))).toBe("media.markers_import_too_large");
	});
});
