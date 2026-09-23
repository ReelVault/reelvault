import { describe, expect, test } from "bun:test";
import type { DetectedHwaccel } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { resolveStreamEncoders } from "./encoder-map";

const hwNone: DetectedHwaccel = { type: "none", device: null, h264Encoder: "libx264", hevcEncoder: "libx265" };
const hwNvenc: DetectedHwaccel = { type: "nvenc", device: null, h264Encoder: "h264_nvenc", hevcEncoder: "hevc_nvenc" };

describe("encoder map", () => {
	test("copy for both streams when nothing transcodes", () => {
		expect(resolveStreamEncoders({ videoTranscode: false, audioTranscode: false }, hwNvenc)).toEqual({
			videoEncoder: "copy",
			audioEncoder: "copy",
		});
	});

	test("software x264 for video when transcoding without hardware", () => {
		expect(resolveStreamEncoders({ videoTranscode: true, audioTranscode: true }, hwNone)).toEqual({
			videoEncoder: "libx264",
			audioEncoder: "aac",
		});
	});

	test("hardware encoder for video when available", () => {
		expect(resolveStreamEncoders({ videoTranscode: true, audioTranscode: false }, hwNvenc)).toEqual({
			videoEncoder: "h264_nvenc",
			audioEncoder: "copy",
		});
	});
});
