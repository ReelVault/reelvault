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
	else if (effectiveHw.type !== "none") videoEncoder = effectiveHw.h264Encoder;
	else videoEncoder = "libx264";

	const audioEncoder = !decision.audioTranscode ? "copy" : "aac";

	return { videoEncoder, audioEncoder };
}
