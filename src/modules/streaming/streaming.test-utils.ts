import type { PlaybackDecision } from "@sdk/common/stream.types";

export function createMockPlaybackDecision(overrides: Partial<PlaybackDecision> = {}): PlaybackDecision {
	return {
		mode: "direct-stream",
		videoTranscode: false,
		audioTranscode: false,
		reason: "mock",
		...overrides,
	};
}
