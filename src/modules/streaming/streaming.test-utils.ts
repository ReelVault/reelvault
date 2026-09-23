import type { PlaybackDecision } from "@reelvault/sdk/common";

export function createMockPlaybackDecision(overrides: Partial<PlaybackDecision> = {}): PlaybackDecision {
	return {
		mode: "direct-stream",
		videoTranscode: false,
		audioTranscode: false,
		reason: "mock",
		...overrides,
	};
}
