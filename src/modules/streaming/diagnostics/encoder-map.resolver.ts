import type { PlaybackDecision } from "@reelvault/sdk/common";
import type { getEffectiveHwaccel } from "@/integrations/ffmpeg/ffmpeg.capabilities";

type EffectiveHwaccel = ReturnType<typeof getEffectiveHwaccel>;

export function resolveStreamEncoders(
	decision: Pick<PlaybackDecision, "videoTranscode" | "audioTranscode" | "forceSoftware">,
	effectiveHw: EffectiveHwaccel,
): { videoEncoder: string; audioEncoder: string } {
	let videoEncoder: string;
	if (!decision.videoTranscode) videoEncoder = "copy";
	else if (decision.forceSoftware === true) videoEncoder = "libx264";
	else if (effectiveHw.type === "none") videoEncoder = "libx264";
	else videoEncoder = effectiveHw.h264Encoder;

	const audioEncoder = decision.audioTranscode ? "aac" : "copy";

	return { videoEncoder, audioEncoder };
}
