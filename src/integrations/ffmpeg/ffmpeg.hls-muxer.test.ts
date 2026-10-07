import { describe, expect, test } from "bun:test";
import type { PlaybackDecision } from "@reelvault/sdk/common";
import { buildHlsOutputPath, buildStreamMapArgs } from "./ffmpeg.hls-muxer";

function decision(audioStreamIndex?: number): PlaybackDecision {
	const value: PlaybackDecision = {
		mode: "direct-stream",
		videoTranscode: false,
		audioTranscode: false,
		videoCodec: "h264",
		reason: "test",
		formatName: "matroska",
		durationSeconds: 60,
		sourceFps: 24,
		...(audioStreamIndex === undefined ? {} : { audioStreamIndex }),
	};

	return value;
}

describe("buildStreamMapArgs", () => {
	test("makes the default audio map optional so silent files still play", () => {
		expect(buildStreamMapArgs(decision())).toEqual(["-map", "0:v:0", "-map", "0:a:0?", "-map", "-0:s"]);
	});

	test("keeps an explicitly selected audio stream optional too", () => {
		expect(buildStreamMapArgs(decision(3))).toEqual(["-map", "0:v:0", "-map", "0:3?", "-map", "-0:s"]);
	});
});

describe("buildHlsOutputPath", () => {
	test("converts a Windows session directory to forward slashes", () => {
		expect(buildHlsOutputPath("C:\\Users\\me\\AppData\\Local\\ReelVault\\data\\transcodes\\s1", "playlist.m3u8")).toBe(
			"C:/Users/me/AppData/Local/ReelVault/data/transcodes/s1/playlist.m3u8",
		);
	});

	test("keeps the segment number placeholder intact", () => {
		expect(buildHlsOutputPath("C:\\transcodes\\s1", "seg_%d.m4s")).toBe("C:/transcodes/s1/seg_%d.m4s");
	});

	test("leaves POSIX paths unchanged", () => {
		expect(buildHlsOutputPath("/tmp/transcodes/s1", "playlist.m3u8")).toBe("/tmp/transcodes/s1/playlist.m3u8");
	});
});
