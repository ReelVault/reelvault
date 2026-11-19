import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { hardenAnalyseArgs } from "./analyse-args.hardener";

const SECURITY_VIOLATION = { category: "validation", code: "plugin.ffmpeg.security_violation" } as const;
const OUTSIDE_PATH = "/etc/reelvault-outside.mp4";

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

describe("hardenAnalyseArgs output files", () => {
	test("allows a single output inside the managed transcode directory and restricts the input to local files", () => {
		const output = join(serverConfig.paths.transcodes, "analysis.json");

		expect(hardenAnalyseArgs(["-i", "input.mkv", "-f", "null", output], false)).toEqual([
			"-protocol_whitelist",
			"file,crypto",
			"-i",
			"input.mkv",
			"-f",
			"null",
			output,
		]);
	});

	test("refuses a single output outside the managed directories", () => {
		expect(() => hardenAnalyseArgs(["-i", "input.mkv", OUTSIDE_PATH], false)).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.ffmpeg.security_violation" }),
		);
	});

	test("refuses a second output outside the managed directories even when the last output is inside", () => {
		const output = join(serverConfig.paths.transcodes, "analysis.json");

		expect(() => hardenAnalyseArgs(["-i", "input.mkv", "-y", OUTSIDE_PATH, output], false)).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.ffmpeg.security_violation" }),
		);
	});

	test("refuses an option that writes a file named by its value, even when the output is inside", () => {
		const output = join(serverConfig.paths.transcodes, "analysis.json");

		expect(() => hardenAnalyseArgs(["-i", "input.mkv", "-passlogfile", OUTSIDE_PATH, "-f", "null", output], false)).toThrow(
			expect.objectContaining({ category: "validation", code: "plugin.ffmpeg.security_violation" }),
		);
	});
});
