import { describe, expect, test } from "bun:test";
import type { TranscodeConfig } from "@reelvault/sdk/common";
import { createMockPlaybackDecision } from "../../streaming.test-utils";
import { TranscodeStrategy } from "./transcode.strategy";

const config: TranscodeConfig = {
	maxSessions: 2,
	inactivityTimeout: 60_000,
	cleanupInterval: 60_000,
	tempRootDir: "/tmp/reelvault-strategies",
	hlsSegmentDuration: 4,
};

describe("transcode strategy", () => {
	test("refuses to start without an input file", () => {
		const strategy = new TranscodeStrategy(config);

		expect(
			strategy.startSession({
				sessionId: "s1",
				inputPath: "/nonexistent/input.mkv",
				outputDir: "/tmp/reelvault-strategies/s1",
				decision: createMockPlaybackDecision({ mode: "transcode" }),
				startTime: 0,
			}),
		).rejects.toThrow("Input file does not exist");
	});
});
