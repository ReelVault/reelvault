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
