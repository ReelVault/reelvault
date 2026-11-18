import { describe, expect, test } from "bun:test";
import { hardenAnalyseArgs } from "./analyse-args.hardener";

const SECURITY_VIOLATION = { category: "validation", code: "plugin.ffmpeg.security_violation" } as const;

describe("hardenAnalyseArgs", () => {
	test.each(["-attach", "-dump_attachment", "-filter_script", "-filter_complex_script"])(
		"rejects the %s flag with a security violation",
		(flag) => {
			expect(() => hardenAnalyseArgs(["-i", "in.mkv", flag, "/etc/passwd", "-"], false)).toThrow(
				expect.objectContaining(SECURITY_VIOLATION),
			);
		},
	);

	test.each(["data", "concat"])("rejects the %s demuxer as an input format", (format) => {
		expect(() => hardenAnalyseArgs(["-f", format, "-i", "list.txt", "-"], false)).toThrow(expect.objectContaining(SECURITY_VIOLATION));
	});

	test.each(["movie=/etc/passwd", "subtitles=/etc/passwd", "textfile=/etc/passwd"])(
		"rejects the %s filter with a security violation",
		(filter) => {
			expect(() => hardenAnalyseArgs(["-i", "in.mkv", "-vf", filter, "-"], false)).toThrow(expect.objectContaining(SECURITY_VIOLATION));
		},
	);

	test("rejects a plugin-supplied protocol whitelist", () => {
		expect(() => hardenAnalyseArgs(["-protocol_whitelist", "file,http", "-i", "in.mkv", "-"], false)).toThrow(
			expect.objectContaining(SECURITY_VIOLATION),
		);
	});

	test("inserts the local-file protocol whitelist before each input", () => {
		expect(hardenAnalyseArgs(["-i", "/media/movie.mkv", "-af", "loudnorm=I=-16", "-f", "null", "-"], false)).toEqual([
			"-protocol_whitelist",
			"file,crypto",
			"-i",
			"/media/movie.mkv",
			"-af",
			"loudnorm=I=-16",
			"-f",
			"null",
			"-",
		]);
	});
});
