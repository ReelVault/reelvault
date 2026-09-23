import { describe, expect, it, spyOn } from "bun:test";
import type { CreateMediaMarker } from "@sdk/common";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { mediaMarkersRepository } from "@/database/repositories/media-markers.repository";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { pluginMarkersService } from "./plugin.markers";

function markerRow(m: CreateMediaMarker, idx: number, pluginId: string, mediaFileId: string) {
	return {
		id: `marker_${idx}`,
		mediaFileId,
		type: m.type,
		startSeconds: m.startSeconds,
		endSeconds: m.endSeconds,
		label: m.label ?? null,
		source: "plugin" as const,
		pluginId,
		createdAt: new Date("2026-08-17T00:00:00.000Z"),
		updatedAt: new Date("2026-08-17T00:00:00.000Z"),
	};
}

describe("PluginMarkersService", () => {
	it("throws NotFoundError for a missing media file without touching markers", async () => {
		const isExistsSpy = spyOn(mediaRepository, "isExists").mockResolvedValue(false);
		const replaceSpy = spyOn(mediaMarkersRepository, "replaceMarkersForMediaFile").mockResolvedValue([]);

		try {
			await expect(pluginMarkersService.setMarkers("intro-skipper", "mf_missing", [])).rejects.toThrow("mf_missing");
			expect(replaceSpy).not.toHaveBeenCalled();
		} finally {
			isExistsSpy.mockRestore();
			replaceSpy.mockRestore();
		}
	});

	it("replaces markers scoped to the calling plugin and publishes media.markers.updated", async () => {
		const input: CreateMediaMarker[] = [
			{ type: "intro", startSeconds: 15.5, endSeconds: 90.0, label: "Opening" },
			{ type: "credits", startSeconds: 1400.0, endSeconds: 1460.0, label: "End Credits" },
		];
		const mediaFileId = "mf_test_123";
		const pluginId = "intro-skipper";

		const isExistsSpy = spyOn(mediaRepository, "isExists").mockResolvedValue(true);
		const replaceSpy = spyOn(mediaMarkersRepository, "replaceMarkersForMediaFile").mockResolvedValue(
			input.map((m, idx) => markerRow(m, idx, pluginId, mediaFileId)),
		);
		const publishSpy = spyOn(pluginEventBus, "publish").mockReturnValue(undefined);

		try {
			const result = await pluginMarkersService.setMarkers(pluginId, mediaFileId, input);

			expect(replaceSpy).toHaveBeenCalledWith(mediaFileId, input, { pluginId, source: "plugin" });
			expect(publishSpy).toHaveBeenCalledWith("media.markers.updated", { mediaFileId, markerCount: 2 });
			// Rows map through toPublicMarker: Date fields become ISO strings.
			expect(result[0]?.createdAt).toBe("2026-08-17T00:00:00.000Z");
			expect(result.every((m) => m.pluginId === pluginId && m.source === "plugin")).toBeTrue();
		} finally {
			isExistsSpy.mockRestore();
			replaceSpy.mockRestore();
			publishSpy.mockRestore();
		}
	});

	it("clearMarkers replaces only the calling plugin's markers and publishes an empty update", async () => {
		const mediaFileId = "mf_test_123";
		const pluginId = "intro-skipper";

		const replaceSpy = spyOn(mediaMarkersRepository, "replaceMarkersForMediaFile").mockResolvedValue([]);
		const publishSpy = spyOn(pluginEventBus, "publish").mockReturnValue(undefined);

		try {
			await pluginMarkersService.clearMarkers(pluginId, mediaFileId);

			expect(replaceSpy).toHaveBeenCalledWith(mediaFileId, [], { pluginId, source: "plugin" });
			expect(publishSpy).toHaveBeenCalledWith("media.markers.updated", { mediaFileId, markerCount: 0 });
		} finally {
			replaceSpy.mockRestore();
			publishSpy.mockRestore();
		}
	});
});
