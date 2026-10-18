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

	test("passes forward-slash output paths so ffmpeg writes the fMP4 init segment next to the playlist", async () => {
		const root = mkdtempSync(join(tmpdir(), "reelvault-direct-stream-"));
		const inputPath = join(root, "input.mkv");
		writeFileSync(inputPath, "");

		let playlistPath = "";
		let outputArgs: string[] = [];
		const fakeProcess = spawn({ cmd: ["true"], stdout: "ignore", stderr: "pipe" });

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
			const outputDir = "C:\\Users\\me\\AppData\\Local\\ReelVault\\data\\transcodes\\s1";
			const strategy = new DirectStreamStrategy(config);

			await strategy.startSession({
				sessionId: "s1",
				inputPath,
				outputDir,
				decision: createMockPlaybackDecision({ mode: "direct-stream" }),
				startTime: 0,
			});

			expect(playlistPath).toBe("C:/Users/me/AppData/Local/ReelVault/data/transcodes/s1/playlist.m3u8");
			expect(outputArgs).toEqual(
				expect.arrayContaining(["-hls_segment_filename", "C:/Users/me/AppData/Local/ReelVault/data/transcodes/s1/seg_%d.m4s"]),
			);
		} finally {
			await fakeProcess.exited;
			removeTreeSync(root);
		}
	});
});
