import { describe, expect, test } from "bun:test";
import { type EpisodeWithFileRow, resolveEffectivePlaybackPreferences, resolveNextEpisodeFileId } from "./playback-view.utils";

const UPDATED_AT = new Date("2026-01-01T00:00:00Z");

function rows(
	episodeId: string,
	seasonId: string,
	seasonNumber: number,
	episodeNumber: number,
	files: Array<{ id: string; isDefault?: boolean; updatedAt?: Date }> = [],
): EpisodeWithFileRow[] {
	if (files.length === 0) {
		return [
			{
				id: episodeId,
				seasonId,
				seasonNumber,
				episodeNumber,
				mediaFileId: null,
				mediaFileIsDefault: null,
				mediaFileUpdatedAt: null,
			},
		];
	}

	return files.map((file) => ({
		id: episodeId,
		seasonId,
		seasonNumber,
		episodeNumber,
		mediaFileId: file.id,
		mediaFileIsDefault: file.isDefault ?? false,
		mediaFileUpdatedAt: file.updatedAt ?? UPDATED_AT,
	}));
}

describe("resolveNextEpisodeFileId", () => {
	test("returns the preferred file of the immediate next episode in the same season", () => {
		const data = [...rows("ep-1", "s-1", 1, 1, [{ id: "f-1" }]), ...rows("ep-2", "s-1", 1, 2, [{ id: "f-2" }])];

		expect(resolveNextEpisodeFileId(data, { id: "ep-1", seasonId: "s-1" })).toBe("f-2");
	});

	test("falls through to the first playable episode of the next season when the next episode has no file", () => {
		const data = [
			...rows("ep-1", "s-1", 1, 1, [{ id: "f-1" }]),
			...rows("ep-2", "s-1", 1, 2),
			...rows("ep-3", "s-2", 2, 1, [{ id: "f-3" }]),
		];

		expect(resolveNextEpisodeFileId(data, { id: "ep-1", seasonId: "s-1" })).toBe("f-3");
	});

	test("skips later seasons whose first episode has no file", () => {
		const data = [
			...rows("ep-1", "s-1", 1, 1, [{ id: "f-1" }]),
			...rows("ep-2", "s-2", 2, 1),
			...rows("ep-3", "s-3", 3, 1, [{ id: "f-3" }]),
		];

		expect(resolveNextEpisodeFileId(data, { id: "ep-1", seasonId: "s-1" })).toBe("f-3");
	});

	test("prefers the default file over a newer non-default file", () => {
		const older = new Date("2026-01-01T00:00:00Z");
		const newer = new Date("2026-02-01T00:00:00Z");
		const data = [
			...rows("ep-1", "s-1", 1, 1, [{ id: "f-1" }]),
			...rows("ep-2", "s-1", 1, 2, [
				{ id: "f-default", isDefault: true, updatedAt: older },
				{ id: "f-newer", updatedAt: newer },
			]),
		];

		expect(resolveNextEpisodeFileId(data, { id: "ep-1", seasonId: "s-1" })).toBe("f-default");
	});

	test("returns null at the end of the show", () => {
		const data = [...rows("ep-1", "s-1", 1, 1, [{ id: "f-1" }]), ...rows("ep-2", "s-1", 1, 2, [{ id: "f-2" }])];

		expect(resolveNextEpisodeFileId(data, { id: "ep-2", seasonId: "s-1" })).toBeNull();
	});

	test("returns null when the current episode is not part of the rows", () => {
		const data = [...rows("ep-1", "s-1", 1, 1, [{ id: "f-1" }])];

		expect(resolveNextEpisodeFileId(data, { id: "ep-missing", seasonId: "s-1" })).toBeNull();
	});

	test("ignores earlier seasons and non-adjacent episodes in the same season", () => {
		const data = [
			...rows("ep-0", "s-0", 0, 1, [{ id: "f-0" }]),
			...rows("ep-1", "s-1", 1, 1, [{ id: "f-1" }]),
			...rows("ep-2", "s-1", 1, 2),
			...rows("ep-3", "s-1", 1, 3, [{ id: "f-3" }]),
		];

		// The immediate next episode (ep-2) has no file, so the later-season scan
		// runs — there are no later seasons, and ep-3 must not be picked.
		expect(resolveNextEpisodeFileId(data, { id: "ep-1", seasonId: "s-1" })).toBeNull();
	});
});

describe("resolveEffectivePlaybackPreferences", () => {
	test("reports no bitrate cap when neither the profile nor the server sets one", () => {
		expect(resolveEffectivePlaybackPreferences({ maxStreamingBitrateKbps: 0, hdrMode: "auto" }, 0)).toEqual({
			maxStreamingBitrateKbps: null,
			hdrMode: "auto",
		});
		expect(resolveEffectivePlaybackPreferences(null, 0)).toEqual({ maxStreamingBitrateKbps: null, hdrMode: "auto" });
	});

	test("the lower of the profile cap and the server limit applies", () => {
		expect(resolveEffectivePlaybackPreferences({ maxStreamingBitrateKbps: 8000 }, 4000).maxStreamingBitrateKbps).toBe(4000);
		expect(resolveEffectivePlaybackPreferences({ maxStreamingBitrateKbps: 4000 }, 8000).maxStreamingBitrateKbps).toBe(4000);
	});

	test("a server limit alone still caps the stream", () => {
		expect(resolveEffectivePlaybackPreferences(null, 6000).maxStreamingBitrateKbps).toBe(6000);
	});

	test("reports the HDR mode and defaults to automatic", () => {
		expect(resolveEffectivePlaybackPreferences({ hdrMode: "toneMapToSdr" }, 0).hdrMode).toBe("toneMapToSdr");
		expect(resolveEffectivePlaybackPreferences(undefined, 0).hdrMode).toBe("auto");
	});
});
