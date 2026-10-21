import { describe, expect, test } from "bun:test";
import { resolveEffectivePlaybackPreferences } from "./playback-view.utils";

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
