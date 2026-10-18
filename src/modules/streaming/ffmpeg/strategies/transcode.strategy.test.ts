import { describe, expect, test } from "bun:test";
import type { TranscodeConfig } from "@reelvault/sdk/common";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { TranscodeStrategy } from "./transcode.strategy";

const config: TranscodeConfig = {
	maxSessions: 2,
	inactivityTimeout: 60_000,
	cleanupInterval: 60_000,
	tempRootDir: "/tmp/reelvault-strategies",
	hlsSegmentDuration: 4,
};

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
});
