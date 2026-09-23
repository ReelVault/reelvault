import { describe, expect, it } from "bun:test";
import type { PlaybackDecision } from "@sdk/common/stream.types";
import { isSoftwareFallbackEligible } from "./software-fallback";

const decision: PlaybackDecision = {
	mode: "transcode",
	videoTranscode: true,
	audioTranscode: false,
	reason: "test",
};

describe("isSoftwareFallbackEligible", () => {
	it("allows one retry for a failed hardware transcode", () => {
		expect(isSoftwareFallbackEligible(decision, "nvenc")).toBeTrue();
	});

	it("rejects software sessions and already-fallen-back retries", () => {
		expect(isSoftwareFallbackEligible(decision, "none")).toBeFalse();
		expect(isSoftwareFallbackEligible({ ...decision, forceSoftware: true }, "nvenc")).toBeFalse();
	});

	it("rejects sessions that never encoded video", () => {
		expect(isSoftwareFallbackEligible({ ...decision, mode: "direct-stream", videoTranscode: false }, "nvenc")).toBeFalse();
		expect(isSoftwareFallbackEligible({ ...decision, videoTranscode: false }, "nvenc")).toBeFalse();
	});
});
