import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "bun";
import { SubtitleExtractorService } from "./subtitle-extractor.service";

const WEBVTT_BODY = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000 t\n\nhello";

interface HarnessOptions {
	mediaFileExists?: (path: string) => Promise<boolean>;
	runFfmpeg?: (args: string[]) => Promise<{ exitCode: number | null; stderr: string }>;
}

function writeWebVttToLastArg(args: string[]): Promise<void> {
	const outputPath = args.at(-1);
	if (!outputPath) return Promise.resolve();

	return writeFile(outputPath, WEBVTT_BODY, "utf8");
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (condition()) return;

		await sleep(2);
	}

	throw new Error("Condition not met in time");
}

describe("SubtitleExtractorService", () => {
	let subtitlesDir: string;

	beforeEach(async () => {
		subtitlesDir = await mkdtemp(join(tmpdir(), "reelvault-subtitle-extractor-"));
	});

	afterEach(async () => {
		await rm(subtitlesDir, { recursive: true, force: true });
	});

	function createExtractor(options: HarnessOptions = {}) {
		const ffmpegCalls: string[][] = [];
		const extractor = new SubtitleExtractorService({
			runFfmpeg: async (args) => {
				ffmpegCalls.push(args);
				if (options.runFfmpeg) return await options.runFfmpeg(args);

				await writeWebVttToLastArg(args);

				return { exitCode: 0, stderr: "" };
			},
			mediaFileExists: options.mediaFileExists ?? (async () => true),
			subtitlesPath: () => subtitlesDir,
			getConcurrency: () => 2,
		});

		return { extractor, ffmpegCalls };
	}

	async function tmpLeftovers(): Promise<string[]> {
		return (await readdir(subtitlesDir)).filter((name) => name.endsWith(".tmp"));
	}

	test("returns null for invalid stream indexes without spawning FFmpeg", async () => {
		const { extractor, ffmpegCalls } = createExtractor();

		expect(await extractor.extractToVtt("sub-idx", "/media/movie.mkv", -1, "subrip")).toBeNull();
		expect(await extractor.extractToVtt("sub-idx", "/media/movie.mkv", null, "subrip")).toBeNull();
		expect(ffmpegCalls).toHaveLength(0);
	});

	test("returns null for bitmap subtitle formats without spawning FFmpeg", async () => {
		const { extractor, ffmpegCalls } = createExtractor();

		expect(await extractor.extractToVtt("sub-pgs", "/media/movie.mkv", 2, "hdmv_pgs_subtitle")).toBeNull();
		expect(await extractor.extractToVtt("sub-pgs", "/media/movie.mkv", 2, ".pgs")).toBeNull();
		expect(await extractor.extractToVtt("sub-pgs", "/media/movie.mkv", 2, "PGSSUB")).toBeNull();
		expect(ffmpegCalls).toHaveLength(0);
	});

	test("returns null when the media file does not exist", async () => {
		const { extractor, ffmpegCalls } = createExtractor({ mediaFileExists: async () => false });

		expect(await extractor.extractToVtt("sub-media", "/media/gone.mkv", 2, "subrip")).toBeNull();
		expect(ffmpegCalls).toHaveLength(0);
	});

	test("propagates an already-aborted signal", () => {
		const { extractor, ffmpegCalls } = createExtractor();
		const controller = new AbortController();
		controller.abort();

		expect(extractor.extractToVtt("sub-abort", "/media/movie.mkv", 2, "subrip", controller.signal)).rejects.toThrow();
		expect(ffmpegCalls).toHaveLength(0);
	});

	test("serves an already extracted VTT from the cache without spawning FFmpeg", async () => {
		await writeFile(join(subtitlesDir, "sub-cached.vtt"), WEBVTT_BODY, "utf8");
		const { extractor, ffmpegCalls } = createExtractor();

		const result = await extractor.extractToVtt("sub-cached", "/media/movie.mkv", 2, "subrip");
		if (!result) throw new Error("Cached VTT should be served");

		expect(result.contentType).toBe("text/vtt");
		expect(await result.file.text()).toBe(WEBVTT_BODY);
		expect(ffmpegCalls).toHaveLength(0);
	});

	test("extracts through FFmpeg, atomically caches the VTT and cleans the temp file", async () => {
		const { extractor, ffmpegCalls } = createExtractor();

		const result = await extractor.extractToVtt("sub-ok", "/media/movie.mkv", 2, "subrip");
		if (!result) throw new Error("Extraction should have succeeded");

		expect(result.contentType).toBe("text/vtt");
		expect(await result.file.text()).toBe(WEBVTT_BODY);
		expect(ffmpegCalls).toHaveLength(1);

		const ffmpegArgs = ffmpegCalls[0];
		if (!ffmpegArgs) throw new Error("FFmpeg argv should be captured");

		expect(ffmpegArgs.slice(0, 10)).toEqual([
			"-nostdin",
			"-loglevel",
			"error",
			"-y",
			"-i",
			"/media/movie.mkv",
			"-map",
			"0:2",
			"-f",
			"webvtt",
		]);
		expect(ffmpegArgs).toHaveLength(11);

		const tempArg = ffmpegArgs.at(-1);
		expect(tempArg).toStartWith(join(subtitlesDir, "sub-ok.vtt"));
		expect(tempArg).toEndWith(".tmp");

		expect(await readFile(join(subtitlesDir, "sub-ok.vtt"), "utf8")).toBe(WEBVTT_BODY);
		expect(await tmpLeftovers()).toEqual([]);
	});

	test("returns null and cleans the temp file when FFmpeg fails", async () => {
		const { extractor, ffmpegCalls } = createExtractor({
			runFfmpeg: async () => ({ exitCode: 1, stderr: "mock ffmpeg failure" }),
		});

		const result = await extractor.extractToVtt("sub-fail", "/media/movie.mkv", 2, "subrip");

		expect(result).toBeNull();
		expect(ffmpegCalls).toHaveLength(1);
		expect(await tmpLeftovers()).toEqual([]);
	});

	test("returns null when FFmpeg succeeds but produces no output file", async () => {
		const { extractor } = createExtractor({ runFfmpeg: async () => ({ exitCode: 0, stderr: "" }) });

		expect(await extractor.extractToVtt("sub-empty", "/media/movie.mkv", 2, "subrip")).toBeNull();
		expect(await tmpLeftovers()).toEqual([]);
	});

	test("deduplicates concurrent extractions of the same subtitle into one FFmpeg run", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { extractor, ffmpegCalls } = createExtractor({
			runFfmpeg: async (args) => {
				await gate;
				await writeWebVttToLastArg(args);

				return { exitCode: 0, stderr: "" };
			},
		});

		const first = extractor.extractToVtt("sub-dedupe", "/media/movie.mkv", 2, "subrip");
		await waitFor(() => ffmpegCalls.length > 0);
		const second = extractor.extractToVtt("sub-dedupe", "/media/movie.mkv", 2, "subrip");
		release();

		const firstResult = await first;
		const secondResult = await second;
		if (!(firstResult && secondResult)) throw new Error("Both callers should receive the extraction result");

		expect(firstResult.contentType).toBe("text/vtt");
		expect(secondResult.contentType).toBe("text/vtt");
		expect(await firstResult.file.text()).toBe(WEBVTT_BODY);
		expect(await secondResult.file.text()).toBe(WEBVTT_BODY);
		expect(ffmpegCalls).toHaveLength(1);
	});

	test("waitForInFlight resolves only after the shared extraction settles", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { extractor, ffmpegCalls } = createExtractor({
			runFfmpeg: async (args) => {
				await gate;
				await writeWebVttToLastArg(args);

				return { exitCode: 0, stderr: "" };
			},
		});

		const extraction = extractor.extractToVtt("sub-wait", "/media/movie.mkv", 2, "subrip");
		await waitFor(() => ffmpegCalls.length > 0);

		let settled = false;
		const waiting = extractor.waitForInFlight("sub-wait").then(() => {
			settled = true;
		});
		await sleep(5);
		expect(settled).toBeFalse();

		release();
		await waiting;

		const result = await extraction;
		if (!result) throw new Error("Extraction should have succeeded");

		expect(result.contentType).toBe("text/vtt");
	});

	test("waitForInFlight settles even when the extraction fails", async () => {
		const { extractor } = createExtractor({ runFfmpeg: async () => ({ exitCode: 1, stderr: "boom" }) });

		const extraction = extractor.extractToVtt("sub-wait-fail", "/media/movie.mkv", 2, "subrip");
		await extractor.waitForInFlight("sub-wait-fail");

		expect(await extraction).toBeNull();
	});

	test("waitForInFlight resolves immediately when nothing is in flight", async () => {
		const { extractor } = createExtractor();

		await extractor.waitForInFlight("unknown");
	});
});
