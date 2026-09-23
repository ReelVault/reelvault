import { describe, expect, test } from "bun:test";
import type { TranscodeConfig } from "@sdk/common/stream.types";
import { createMockPlaybackDecision } from "../../streaming.test-utils";
import { DirectStreamStrategy } from "./direct-stream.strategy";

const config: TranscodeConfig = {
	maxSessions: 2,
	inactivityTimeout: 60_000,
	cleanupInterval: 60_000,
	tempRootDir: "/tmp/reelvault-strategies",
	hlsSegmentDuration: 4,
};

describe("direct-stream strategy", () => {
	test("refuses to start without an input file", () => {
		const strategy = new DirectStreamStrategy(config);

		expect(
			strategy.startSession(
				"s1",
				"/nonexistent/input.mkv",
				"/tmp/reelvault-strategies/s1",
				createMockPlaybackDecision({ mode: "direct-stream" }),
				0,
			),
		).rejects.toThrow("Input file does not exist");
	});
});
