import { describe, expect, it } from "bun:test";
import type { PlaybackDecision } from "@reelvault/sdk/common";
import { isSoftwareFallbackEligible, usesSoftwareVideoEncode } from "./software-fallback.policy";

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

describe("usesSoftwareVideoEncode", () => {
	it("counts a CPU transcode and a software fallback, but not hardware or remuxes", () => {
		expect(usesSoftwareVideoEncode(decision, "none")).toBeTrue();
		expect(usesSoftwareVideoEncode({ ...decision, forceSoftware: true }, "nvenc")).toBeTrue();
		expect(usesSoftwareVideoEncode(decision, "nvenc")).toBeFalse();
		expect(usesSoftwareVideoEncode({ ...decision, videoTranscode: false }, "none")).toBeFalse();
	});
});
