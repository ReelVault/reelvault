import { describe, expect, test } from "bun:test";
import type { PlaybackViewResponse } from "@reelvault/sdk/common";
import { resolveEffectivePlaybackPreferences, selectCompatibleProgress } from "./playback-view.utils";

function savedProgress(mediaFileId: string, duration: number): NonNullable<PlaybackViewResponse["progress"]> {
	return {
		mediaFileId,
		position: 600,
		duration,
		completed: false,
		audioStreamIndex: null,
		subtitleId: null,
		updatedAt: "2026-01-02T00:00:00.000Z",
	};
}

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

describe("selectCompatibleProgress", () => {
	test("returns the first compatible candidate in the order supplied by the caller", () => {
		const result = selectCompatibleProgress([savedProgress("exact-file", 1200), savedProgress("other-version", 1200)], 1200);

		expect(result?.mediaFileId).toBe("exact-file");
	});

	test("falls back to the aggregate when the exact file's saved duration no longer fits", () => {
		const result = selectCompatibleProgress([savedProgress("exact-file", 1800), savedProgress("other-version", 1200)], 1200);

		expect(result?.mediaFileId).toBe("other-version");
	});

	test("returns null when no saved duration fits the opened file", () => {
		const result = selectCompatibleProgress([savedProgress("other-version", 1800)], 1200);

		expect(result).toBeNull();
	});

	test("accepts a two-second duration difference", () => {
		const result = selectCompatibleProgress([savedProgress("near-version", 1202)], 1200);

		expect(result?.mediaFileId).toBe("near-version");
	});

	test("accepts progress when the saved duration is unknown", () => {
		const result = selectCompatibleProgress([savedProgress("unknown-duration", 0)], 1200);

		expect(result?.mediaFileId).toBe("unknown-duration");
	});

	test("accepts progress when the opened file's duration is unknown", () => {
		const result = selectCompatibleProgress([savedProgress("saved-duration", 1200)], null);

		expect(result?.mediaFileId).toBe("saved-duration");
	});
});
