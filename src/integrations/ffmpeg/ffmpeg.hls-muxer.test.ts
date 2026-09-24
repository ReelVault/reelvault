import { describe, expect, test } from "bun:test";
import { buildHlsOutputPath } from "./ffmpeg.hls-muxer";

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
