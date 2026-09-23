import { describe, expect, it } from "bun:test";
import { buildFrameExtractionCommand, buildSpriteExtractionCommand } from "./ffmpeg.frame-extract";

describe("frame extraction commands", () => {
	it("builds a fixed frame extraction command without plugin-supplied arguments", () => {
		expect(
			buildFrameExtractionCommand("/library/movie.mkv", {
				mediaFileId: "file-1",
				timeMs: 12_345,
				width: 640,
				format: "webp",
			}),
		).toEqual([
			"-hide_banner",
			"-loglevel",
			"error",
			"-ss",
			"12.345",
			"-i",
			"/library/movie.mkv",
			"-frames:v",
			"1",
			"-vf",
			"scale=640:-2",
			"-c:v",
			"libwebp",
			"-f",
			"image2pipe",
			"-",
		]);
	});

	it("builds a fixed sprite extraction command from bounded frame times", () => {
		expect(
			buildSpriteExtractionCommand("/library/movie.mkv", {
				mediaFileId: "file-1",
				timeMs: [0, 30_000],
				width: 320,
				height: 180,
				columns: 2,
			}),
		).toEqual([
			"-hide_banner",
			"-loglevel",
			"error",
			"-ss",
			"0.000",
			"-i",
			"/library/movie.mkv",
			"-ss",
			"30.000",
			"-i",
			"/library/movie.mkv",
			"-filter_complex",
			"[0:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black[s0];[1:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black[s1];[s0][s1]xstack=inputs=2:layout=0_0|w0_0[sprite]",
			"-map",
			"[sprite]",
			"-frames:v",
			"1",
			"-c:v",
			"libwebp",
			"-f",
			"image2pipe",
			"-",
		]);
	});
});
