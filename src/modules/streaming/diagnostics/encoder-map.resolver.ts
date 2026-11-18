import type { PlaybackDecision } from "@reelvault/sdk/common";
import type { getEffectiveHwaccel } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { usesSoftwareVideoEncode } from "@/modules/streaming/ffmpeg/software-fallback.policy";

type EffectiveHwaccel = ReturnType<typeof getEffectiveHwaccel>;

export function resolveStreamEncoders(
	decision: Pick<PlaybackDecision, "videoTranscode" | "audioTranscode" | "forceSoftware">,
	effectiveHw: EffectiveHwaccel,
): { videoEncoder: string; audioEncoder: string } {
	const audioEncoder = decision.audioTranscode ? "aac" : "copy";
	if (!decision.videoTranscode) return { videoEncoder: "copy", audioEncoder };

	const videoEncoder = usesSoftwareVideoEncode(decision, effectiveHw.type) ? "libx264" : effectiveHw.h264Encoder;

	return { videoEncoder, audioEncoder };
}
