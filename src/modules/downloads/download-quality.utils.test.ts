import { describe, expect, test } from "bun:test";
import { buildDownloadOutputArgs, ffmpegTimeToSeconds, resolveDownloadQuality } from "./download-quality.utils";

describe("ffmpegTimeToSeconds", () => {
	test("parses HH:MM:SS.xx progress timestamps", () => {
		expect(ffmpegTimeToSeconds("00:00:00.00")).toBe(0);
		expect(ffmpegTimeToSeconds("00:01:30.40")).toBeCloseTo(90.4);
		expect(ffmpegTimeToSeconds("01:02:03.00")).toBe(3723);
	});

	test("rejects garbage as zero", () => {
		expect(ffmpegTimeToSeconds("not-a-time")).toBe(0);
	});
});

describe("buildDownloadOutputArgs", () => {
	test("original stream-copies with faststart and no re-encode", () => {
		const args = buildDownloadOutputArgs("original", 600);
		expect(args).toContain("-c");
		expect(args).toContain("copy");
		expect(args).toContain("+faststart");
		expect(args).not.toContain("libx264");
	});

	test("re-encode presets scale, cap bitrate and faststart", () => {
		const args = buildDownloadOutputArgs("720p-mobile", 600);
		const vfIndex = args.indexOf("-vf");
		expect(args[vfIndex + 1]).toContain("scale=1280:720");
		expect(args).toContain("2500k");
		expect(args).toContain("+faststart");
	});
});

describe("resolveDownloadQuality", () => {
	test("falls back to 720p for unknown quality", () => {
		expect(resolveDownloadQuality("8k-ultra").width).toBe(1280);
		expect(resolveDownloadQuality("original").videoBitrateKbps).toBe(0);
	});
});
