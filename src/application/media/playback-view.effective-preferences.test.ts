import { describe, expect, test } from "bun:test";
import { resolveEffectivePlaybackPreferences } from "./playback-view.utils";

/** The playback view tells the client which bitrate cap a stream runs under and which HDR mode applies. */
describe("resolveEffectivePlaybackPreferences", () => {
	test("the lower of the profile cap and the server cap applies", () => {
		expect(resolveEffectivePlaybackPreferences({ maxStreamingBitrateKbps: 8000, hdrMode: "toneMapToSdr" }, 12000)).toEqual({
			maxStreamingBitrateKbps: 8000,
			hdrMode: "toneMapToSdr",
		});
		expect(resolveEffectivePlaybackPreferences({ maxStreamingBitrateKbps: 20000, hdrMode: "auto" }, 12000)).toEqual({
			maxStreamingBitrateKbps: 12000,
			hdrMode: "auto",
		});
	});

	test("the server cap alone applies when the profile sets none, and no cap means no limit", () => {
		expect(resolveEffectivePlaybackPreferences({ maxStreamingBitrateKbps: 0, hdrMode: "auto" }, 12000).maxStreamingBitrateKbps).toBe(12000);
		expect(resolveEffectivePlaybackPreferences(null, 0)).toEqual({ maxStreamingBitrateKbps: null, hdrMode: "auto" });
	});
});
