import { describe, expect, test } from "bun:test";
import type { InferTable } from "@/database/types";
import { toPublicMarker } from "./media-marker.mapper";

type MediaMarkerRow = InferTable<"mediaMarkers">;

describe("toPublicMarker", () => {
	test("maps a table row to the public contract with ISO timestamps", () => {
		const row: MediaMarkerRow = {
			id: "marker-1",
			mediaFileId: "file-1",
			type: "intro",
			startSeconds: 15.5,
			endSeconds: 90,
			label: "Opening",
			source: "plugin",
			pluginId: "org.reelvault.intro-skipper",
			createdAt: new Date("2026-08-17T00:00:00.000Z"),
			updatedAt: new Date("2026-08-17T12:34:56.000Z"),
		};

		expect(toPublicMarker(row)).toEqual({
			id: "marker-1",
			mediaFileId: "file-1",
			type: "intro",
			startSeconds: 15.5,
			endSeconds: 90,
			label: "Opening",
			source: "plugin",
			pluginId: "org.reelvault.intro-skipper",
			createdAt: "2026-08-17T00:00:00.000Z",
			updatedAt: "2026-08-17T12:34:56.000Z",
		});
	});

	test("keeps nullable label and pluginId as null", () => {
		const row: MediaMarkerRow = {
			id: "marker-2",
			mediaFileId: "file-1",
			type: "chapter",
			startSeconds: 0,
			endSeconds: 10,
			label: null,
			source: "manual",
			pluginId: null,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		};

		const mapped = toPublicMarker(row);
		expect(mapped.label).toBe(null);
		expect(mapped.pluginId).toBe(null);
	});
});
