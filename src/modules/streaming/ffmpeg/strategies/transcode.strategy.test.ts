import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../../../tests/helpers/module-mock.helper";
import { TranscodeStrategy } from "./transcode.strategy";

const config = {
	maxSessions: 2,
	inactivityTimeout: 60_000,
	cleanupInterval: 60_000,
	tempRootDir: "/tmp/reelvault-strategies",
	hlsSegmentDuration: 4,
};

// The accelerator is a probe of the host, so the test replaces it: the log must
// report the accelerator that encodes, not the one the machine happens to have.
mockModuleWithRealExports("@/integrations/ffmpeg/ffmpeg.capabilities", {
	getEffectiveHwaccel: () => ({ type: "nvenc", device: null, h264Encoder: "h264_nvenc", hevcEncoder: "hevc_nvenc" }),
});

const fakeSubprocess = {
	pid: 1,
	exitCode: null,
	signalCode: null,
	exited: new Promise<never>(() => {
		// never settles — the fake process is never asked to exit
	}),
	kill: () => {
		// nothing to kill
	},
} as unknown as Subprocess;

/** A builder that records nothing and starts no process. */
function stubFfmpegBuilder(): void {
	const builder = {
		inputArgs: () => builder,
		input: () => builder,
		outputArgs: () => builder,
		withOperationLog: () => builder,
		purpose: () => builder,
		label: () => builder,
		onError: () => builder,
		onProgress: () => builder,
		onExit: () => builder,
		run: () => fakeSubprocess,
	};
	spyOn(ffMpegService, "create").mockReturnValue(builder as unknown as ReturnType<typeof ffMpegService.create>);
}

afterEach(() => {
	spyOn(ffMpegService, "create").mockRestore();
});

afterAll(() => {
	restoreModuleMocks();
});

describe("transcode strategy", () => {
	test("refuses to start without an input file", async () => {
		const strategy = new TranscodeStrategy(config);

		await expect(
			strategy.startSession({
				sessionId: "s1",
				inputPath: "/nonexistent/input.mkv",
				outputDir: "/tmp/reelvault-strategies/s1",
				decision: createMockPlaybackDecision({ mode: "transcode" }),
				startTime: 0,
			}),
		).rejects.toMatchObject({ category: "not_found", code: "media_file.missing" });
	});

	// The configured setting ("auto", "none") says nothing about what encodes
	// the stream. The log has to name the accelerator and its encoder.
	test("logs the accelerator that encodes the stream", async () => {
		const root = mkdtempSync(join(tmpdir(), "reelvault-strategy-log-"));
		const input = join(root, "input.mkv");
		writeFileSync(input, "not-a-real-media-file");
		const strategy = new TranscodeStrategy(config);
		stubFfmpegBuilder();
		const entries: Array<{ message: string; meta: unknown }> = [];
		spyOn(strategy.logger, "debug").mockImplementation((message: string, meta?: unknown) => {
			entries.push({ message, meta });
		});

		await strategy.startSession({
			sessionId: "s1",
			inputPath: input,
			outputDir: join(root, "out"),
			decision: createMockPlaybackDecision({ mode: "transcode", videoTranscode: true }),
			startTime: 0,
		});

		const video = entries.find((entry) => entry.message === "Transcoding video");
		expect(video?.meta).toMatchObject({ sessionId: "s1", accelerator: "nvenc", encoder: "h264_nvenc" });
	});

	test("logs the software encoder when no accelerator is in use", async () => {
		const root = mkdtempSync(join(tmpdir(), "reelvault-strategy-log-"));
		const input = join(root, "input.mkv");
		writeFileSync(input, "not-a-real-media-file");
		const strategy = new TranscodeStrategy(config);
		stubFfmpegBuilder();
		const entries: Array<{ message: string; meta: unknown }> = [];
		spyOn(strategy.logger, "debug").mockImplementation((message: string, meta?: unknown) => {
			entries.push({ message, meta });
		});

		await strategy.startSession({
			sessionId: "s2",
			inputPath: input,
			outputDir: join(root, "out"),
			decision: createMockPlaybackDecision({ mode: "transcode", videoTranscode: true, forceSoftware: true }),
			startTime: 0,
		});

		const video = entries.find((entry) => entry.message === "Transcoding video");
		expect(video?.meta).toMatchObject({ sessionId: "s2", accelerator: "none", encoder: "libx264" });
	});
});
