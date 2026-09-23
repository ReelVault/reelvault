import { describe, expect, test } from "bun:test";
import { buildWebVttExtractionArgs, isBitmapSubtitleFormat } from "./ffmpeg-args";

describe("buildWebVttExtractionArgs", () => {
	test("builds the exact FFmpeg argv for a WebVTT stream extraction", () => {
		const args = buildWebVttExtractionArgs("/media/movie.mkv", 3, "/tmp/sub-1.vtt.abc.tmp");

		expect(args).toEqual([
			"-nostdin",
			"-loglevel",
			"error",
			"-y",
			"-i",
			"/media/movie.mkv",
			"-map",
			"0:3",
			"-f",
			"webvtt",
			"/tmp/sub-1.vtt.abc.tmp",
		]);
	});

	test("maps the stream index into the -map argument and keeps the output last", () => {
		const args = buildWebVttExtractionArgs("/media/show.mkv", 0, "/tmp/out.vtt");

		expect(args.at(7)).toBe("0:0");
		expect(args.at(-1)).toBe("/tmp/out.vtt");
	});
});

describe("isBitmapSubtitleFormat", () => {
	test("recognizes bitmap subtitle codecs regardless of case", () => {
		expect(isBitmapSubtitleFormat("hdmv_pgs_subtitle")).toBeTrue();
		expect(isBitmapSubtitleFormat("PGSSUB")).toBeTrue();
		expect(isBitmapSubtitleFormat("Dvd_Subtitle")).toBeTrue();
		expect(isBitmapSubtitleFormat("dvb_teletext")).toBeTrue();
	});

	test("strips a leading extension dot before matching", () => {
		expect(isBitmapSubtitleFormat(".pgs")).toBeTrue();
		expect(isBitmapSubtitleFormat(".vobsub")).toBeTrue();
	});

	test("rejects text subtitle formats and empty input", () => {
		expect(isBitmapSubtitleFormat("subrip")).toBeFalse();
		expect(isBitmapSubtitleFormat("srt")).toBeFalse();
		expect(isBitmapSubtitleFormat("mov_text")).toBeFalse();
		expect(isBitmapSubtitleFormat("webvtt")).toBeFalse();
		expect(isBitmapSubtitleFormat("")).toBeFalse();
		expect(isBitmapSubtitleFormat(null)).toBeFalse();
		expect(isBitmapSubtitleFormat(undefined)).toBeFalse();
	});
});
