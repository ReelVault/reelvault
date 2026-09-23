import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaybackDecision, TranscodeConfig } from "@sdk/common/stream.types";
import { fmtMs, main, printTable, suiteArgs, task } from "benchkit";
import { $ } from "bun";
import { DirectStreamStrategy } from "@/modules/streaming/ffmpeg/strategies/direct-stream.strategy";
import { TranscodeStrategy } from "@/modules/streaming/ffmpeg/strategies/transcode.strategy";

const config: TranscodeConfig = {
	maxSessions: 4,
	inactivityTimeout: 30_000,
	cleanupInterval: 10_000,
	tempRootDir: "/tmp/reelvault-ffmpeg-benchmark",
	hlsSegmentDuration: 2,
};

const directDecision: PlaybackDecision = {
	mode: "direct-stream",
	videoTranscode: false,
	audioTranscode: false,
	reason: "benchmark direct stream",
};

const transcodeDecision: PlaybackDecision = {
	mode: "transcode",
	videoTranscode: true,
	audioTranscode: true,
	reason: "benchmark transcode",
};

const countSegments = (playlist: string): number => playlist.split("\n").filter((line) => line.endsWith(".m4s")).length;

export const meta = { description: "FFmpeg strategy runtime (direct-stream vs transcode vs seek execution)" };

const args = suiteArgs();

if (!args.help) {
	task("ffmpeg: strategies", async () => {
		const root = await mkdtemp(join(tmpdir(), "reelvault-benchmark-ffmpeg-"));
		try {
			const fixturePath = join(root, "fixture.mp4");
			console.log("[ffmpeg] generating test fixture with lavfi testsrc (5s)...");
			await $`ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc=size=640x360:rate=24 -f lavfi -i sine=frequency=1000:sample_rate=48000 -t 5 -c:v libx264 -pix_fmt yuv420p -c:a aac ${fixturePath}`;

			const directStrategy = new DirectStreamStrategy(config);
			const transcodeStrategy = new TranscodeStrategy(config);

			const scenarios = [
				{ name: "Direct stream (remux only)", strategy: directStrategy, decision: directDecision, startTime: 0 },
				{ name: "Transcode from start (x264 + aac)", strategy: transcodeStrategy, decision: transcodeDecision, startTime: 0 },
				{ name: "Transcode with seek (offset 2s)", strategy: transcodeStrategy, decision: transcodeDecision, startTime: 2 },
			] as const;

			const rows: string[][] = [];

			for (const scenario of scenarios) {
				console.log(`[ffmpeg] running ${scenario.name}...`);
				const outputDir = join(root, scenario.name.replace(/\s+/g, "-").toLowerCase());
				await mkdir(outputDir, { recursive: true });
				const sessionId = `bench-${Date.now()}`;
				const startedAt = performance.now();
				const proc = await scenario.strategy.startSession(sessionId, fixturePath, outputDir, scenario.decision, scenario.startTime);
				const exitCode = await proc.exited;
				const elapsedMs = performance.now() - startedAt;

				if (exitCode !== 0) {
					throw new Error(`${scenario.name} exited with code ${exitCode}`);
				}

				const playlist = await readFile(join(outputDir, "playlist.m3u8"), "utf8");
				const segments = countSegments(playlist);
				rows.push([scenario.name, fmtMs(elapsedMs), `${Buffer.byteLength(playlist)} B`, String(segments)]);
			}

			printTable("FFmpeg Strategy Runtime Results", ["scenario", "elapsed", "playlist size", "segments"], rows);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

await main(import.meta);
