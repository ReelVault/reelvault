import { describe, expect, it } from "bun:test";
import { buildFrameExtractionCommand, buildSingleFrameExtractionCommand, buildSpriteTileCommand } from "./ffmpeg.frame-extract";

describe("frame extraction commands", () => {
	it("builds a WebP frame command that seeks to the requested time and scales to the width", () => {
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
			"-threads",
			"1",
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
			"-threads",
			"1",
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
			"-threads",
			"1",
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
			"-threads",
			"1",
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
			"-threads",
			"1",
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
