import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscodeConfig } from "@reelvault/sdk/common";
import { spawn } from "bun";
import { FFmpegBuilder } from "@/integrations/ffmpeg/ffmpeg.builder";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { removeTreeSync } from "@/utils/directory.utils";
import { DirectStreamStrategy } from "./direct-stream.strategy";

const config: TranscodeConfig = {
	maxSessions: 2,
	inactivityTimeout: 60_000,
	cleanupInterval: 60_000,
	tempRootDir: "/tmp/reelvault-strategies",
	hlsSegmentDuration: 4,
};

/** The value that follows a flag in an argument list. */
function valueAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);

	return index === -1 ? undefined : args[index + 1];
}

describe("direct-stream strategy", () => {
	test("refuses to start without an input file", async () => {
		const strategy = new DirectStreamStrategy(config);

		await expect(
			strategy.startSession({
				sessionId: "s1",
				inputPath: "/nonexistent/input.mkv",
				outputDir: "/tmp/reelvault-strategies/s1",
				decision: createMockPlaybackDecision({ mode: "direct-stream" }),
				startTime: 0,
			}),
		).rejects.toMatchObject({ category: "not_found", code: "media_file.missing" });
	});
});

describe("direct-stream strategy output paths", () => {
	const spies: Array<{ mockRestore: () => void }> = [];

	afterEach(() => {
		for (const spy of spies) spy.mockRestore();

		spies.length = 0;
	});

	test("writes the playlist and segment paths with forward slashes, which FFmpeg needs to place the init segment beside the playlist", async () => {
		const root = mkdtempSync(join(tmpdir(), "reelvault-direct-stream-"));
		const inputPath = join(root, "input.mkv");
		writeFileSync(inputPath, "");

		let playlistPath = "";
		let outputArgs: string[] = [];
		const fakeProcess = spawn({ cmd: [process.execPath, "-e", "process.exit(0)"], stdout: "ignore", stderr: "pipe" });

		class FakeBuilder extends FFmpegBuilder {
			override input() {
				return this;
			}
			override outputArgs(args: string[]) {
				outputArgs = args;

				return this;
			}
			override withOperationLog() {
				return this;
			}
			override purpose() {
				return this;
			}
			override label() {
				return this;
			}
			override onError() {
				return this;
			}
			override onProgress() {
				return this;
			}
			override onExit() {
				return this;
			}
			override run(outputPath: string) {
				playlistPath = outputPath;

				return fakeProcess;
			}
		}

		spies.push(spyOn(ffMpegService, "create").mockReturnValue(new FakeBuilder()));

		try {
			const outputDir = String.raw`C:\Users\me\AppData\Local\ReelVault\data\transcodes\s1`;
			const strategy = new DirectStreamStrategy(config);

			await strategy.startSession({
				sessionId: "s1",
				inputPath,
				outputDir,
				decision: createMockPlaybackDecision({ mode: "direct-stream" }),
				startTime: 0,
			});

			expect(playlistPath).toBe("C:/Users/me/AppData/Local/ReelVault/data/transcodes/s1/playlist.m3u8");
			expect(valueAfter(outputArgs, "-hls_segment_filename")).toBe("C:/Users/me/AppData/Local/ReelVault/data/transcodes/s1/seg_%d.m4s");
		} finally {
			await fakeProcess.exited;
			removeTreeSync(root);
		}
	});
});

describe("direct-stream strategy input args", () => {
	const spies: Array<{ mockRestore: () => void }> = [];

	afterEach(() => {
		for (const spy of spies) spy.mockRestore();

		spies.length = 0;
	});

	async function captureInputArgs(overrides: { startTime?: number | undefined } = {}): Promise<string[]> {
		const root = mkdtempSync(join(tmpdir(), "reelvault-direct-args-"));
		const inputPath = join(root, "input.mkv");
		writeFileSync(inputPath, "");
		let inputArgs: string[] = [];
		const fakeProcess = spawn({ cmd: [process.execPath, "-e", "process.exit(0)"], stdout: "ignore", stderr: "pipe" });

		class CapturingBuilder extends FFmpegBuilder {
			override inputArgs(args: string[]) {
				inputArgs = args;

				return this;
			}
			override input() {
				return this;
			}
			override outputArgs() {
				return this;
			}
			override withOperationLog() {
				return this;
			}
			override purpose() {
				return this;
			}
			override label() {
				return this;
			}
			override onError() {
				return this;
			}
			override onProgress() {
				return this;
			}
			override onExit() {
				return this;
			}
			override run() {
				return fakeProcess;
			}
		}
		spies.push(spyOn(ffMpegService, "create").mockReturnValue(new CapturingBuilder()));

		try {
			await new DirectStreamStrategy(config).startSession({
				sessionId: "s1",
				inputPath,
				outputDir: join(root, "out"),
				decision: createMockPlaybackDecision({ mode: "direct-stream" }),
				...(overrides.startTime === undefined ? {} : { startTime: overrides.startTime }),
			});

			return inputArgs;
		} finally {
			await fakeProcess.exited;
			removeTreeSync(root);
		}
	}

	test("generates missing PTS and omits the input seek at the default start time", async () => {
		const args = await captureInputArgs();
		const genptsIndex = args.indexOf("+genpts");

		expect(args[genptsIndex - 1]).toBe("-fflags");
		expect(args).not.toContain("-ss");
	});

	test("adds a fast input seek only when starting after zero", async () => {
		const args = await captureInputArgs({ startTime: 30 });
		const seekIndex = args.indexOf("-ss");

		expect(args[seekIndex + 1]).toBe("30");
		expect(args[seekIndex + 2]).toBe("-noaccurate_seek");
	});
});
