import type { PlaybackDecision, TranscodeConfig } from "@reelvault/sdk/common";
import type { StreamingStrategy } from "../../streaming.types";
import { DirectStreamStrategy } from "./direct-stream.strategy";
import { TranscodeStrategy } from "./transcode.strategy";

export function createStrategyRegistry(config: TranscodeConfig): Record<PlaybackDecision["mode"], StreamingStrategy> {
	return {
		"direct-stream": new DirectStreamStrategy(config),
		transcode: new TranscodeStrategy(config),
	};
}
