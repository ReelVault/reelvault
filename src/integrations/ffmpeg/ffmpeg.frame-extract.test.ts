import { describe, expect, it } from "bun:test";
import {
	buildFrameExtractionCommand,
	buildSingleFrameExtractionCommand,
	buildSpriteExtractionCommand,
	buildSpriteTileCommand,
} from "./ffmpeg.frame-extract";

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

	// The plugin writes the frame to a temp file, so the command targets a file
	// and not the standard output. The output path is what production uses.
	it("writes the frame to the given file instead of the standard output", () => {
		expect(
			buildFrameExtractionCommand(
				"/library/movie.mkv",
				{ mediaFileId: "file-1", timeMs: 12_345, width: 640, format: "webp" },
				"/tmp/frame.webp",
			),
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
			"-y",
			"/tmp/frame.webp",
		]);
	});
});

describe("frame extraction with hardware decoding", () => {
	it("puts the hardware decode arguments before the input", () => {
		const command = buildFrameExtractionCommand(
			"/library/movie.mkv",
			{ mediaFileId: "file-1", timeMs: 12_345, width: 640, format: "webp" },
			"/tmp/frame.webp",
			["-hwaccel", "cuda"],
		);

		expect(command).toEqual([
			"-hide_banner",
			"-loglevel",
			"error",
			"-hwaccel",
			"cuda",
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
			"-y",
			"/tmp/frame.webp",
		]);
	});
});

describe("sprite extraction commands", () => {
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

	// The trickplay job writes the sheet to a file, so the sprite command
	// targets a file too.
	it("writes the sprite sheet to the given file", () => {
		expect(
			buildSpriteExtractionCommand(
				"/library/movie.mkv",
				{ mediaFileId: "file-1", timeMs: [0, 30_000], width: 320, height: 180, columns: 2 },
				"/tmp/sprite.webp",
			),
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
			"-y",
			"/tmp/sprite.webp",
		]);
	});

	// A sprite that fills more than one row: the third frame belongs to the
	// second row, and the layout says so.
	it("lays a sprite out over more than one row", () => {
		const command = buildSpriteExtractionCommand("/library/movie.mkv", {
			mediaFileId: "file-1",
			timeMs: [0, 30_000, 60_000],
			width: 320,
			height: 180,
			columns: 2,
		});

		const filterIndex = command.indexOf("-filter_complex");
		expect(command[filterIndex + 1]).toBe(
			"[0:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black[s0];[1:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black[s1];[2:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black[s2];[s0][s1][s2]xstack=inputs=3:layout=0_0|w0_0|0_h0[sprite]",
		);
	});
});

describe("single frame extraction commands", () => {
	it("builds a padded frame command that writes to the given file", () => {
		expect(
			buildSingleFrameExtractionCommand({
				inputPath: "/library/movie.mkv",
				timeMs: 5_000,
				width: 320,
				height: 180,
				format: "webp",
				outputPath: "/tmp/frames/frame_0000.webp",
			}),
		).toEqual([
			"-hide_banner",
			"-loglevel",
			"error",
			"-ss",
			"5.000",
			"-i",
			"/library/movie.mkv",
			"-frames:v",
			"1",
			"-vf",
			"scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black",
			"-c:v",
			"libwebp",
			"-y",
			"/tmp/frames/frame_0000.webp",
		]);
	});

	it("puts the hardware decode arguments before the input", () => {
		expect(
			buildSingleFrameExtractionCommand({
				inputPath: "/library/movie.mkv",
				timeMs: 5_000,
				width: 320,
				height: 180,
				format: "jpeg",
				outputPath: "/tmp/frames/frame_0000.jpg",
				hwDecodeArgs: ["-hwaccel", "vaapi"],
			}),
		).toEqual([
			"-hide_banner",
			"-loglevel",
			"error",
			"-hwaccel",
			"vaapi",
			"-ss",
			"5.000",
			"-i",
			"/library/movie.mkv",
			"-frames:v",
			"1",
			"-vf",
			"scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black",
			"-c:v",
			"mjpeg",
			"-y",
			"/tmp/frames/frame_0000.jpg",
		]);
	});
});

describe("sprite tile commands", () => {
	it("tiles the extracted frames into a grid", () => {
		expect(buildSpriteTileCommand("/tmp/frames/frame_%04d.webp", 3, 2, "webp", "/tmp/sprite.webp")).toEqual([
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			"/tmp/frames/frame_%04d.webp",
			"-vf",
			"tile=layout=3x2",
			"-c:v",
			"libwebp",
			"-y",
			"/tmp/sprite.webp",
		]);
	});
});
