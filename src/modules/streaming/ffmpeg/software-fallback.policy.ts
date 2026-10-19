import type { PlaybackDecision } from "@reelvault/sdk/common";

/**
 * One-shot eligibility for retrying a dead transcode process on the CPU encoder.
 * Only real hardware-encode failures qualify: software sessions have nowhere
 * left to fall back to, and neither does an already-fallen-back retry.
 */
export function isSoftwareFallbackEligible(decision: PlaybackDecision, hwaccelType: string): boolean {
	return decision.mode === "transcode" && decision.videoTranscode && !decision.forceSoftware && hwaccelType !== "none";
}

/** Whether the session's video is encoded on the CPU (including a software fallback). */
export function usesSoftwareVideoEncode(decision: PlaybackDecision, hwaccelType: string): boolean {
	return decision.videoTranscode && (decision.forceSoftware === true || hwaccelType === "none");
}
