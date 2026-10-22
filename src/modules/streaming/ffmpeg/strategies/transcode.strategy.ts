import type { Subprocess } from "bun";
import { serverConfig } from "@/config/server/server.config";
import { getEffectiveHwaccel, resolveToneMapConfig } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { buildDecisionStreamMapArgs, buildHlsMuxerArgs, buildMetadataStripArgs } from "@/integrations/ffmpeg/ffmpeg.hls-muxer";
import { ffmpegProcessTracker } from "@/integrations/ffmpeg/ffmpeg.process-tracker";
import { resolveStreamingThreads } from "@/integrations/ffmpeg/ffmpeg.threads";
import { buildHwaccelInputArgs, buildTranscodeAudioArgs, buildTranscodeVideoArgs } from "@/integrations/ffmpeg/ffmpeg.transcode-args";
import type { StreamStartInput } from "@/modules/streaming/streaming.types";
import { BaseStreamingStrategy } from "./base-streaming.strategy";

/**
 * Re-encodes whichever stream(s) the client can't play natively (libx264 / AAC).
 *
 * Input seek (`-ss` before `-i`) is accurate by default: FFmpeg decodes and
 * discards frames from the preceding keyframe up to the requested offset, so the
 * output starts exactly at `startTime`. The client clock assumes local 0 ==
 * startTime (subtitle/UI timing), so seek accuracy here is load-bearing.
 * Audio PTS are aligned via `aresample=async=1:first_pts=0` in the filter graph.
 */
export class TranscodeStrategy extends BaseStreamingStrategy {
	async startSession({ sessionId, inputPath, outputDir, decision, startTime = 0, operationId }: StreamStartInput): Promise<Subprocess> {
		const { segmentPattern, startNumber } = await this.prepareSession(inputPath, outputDir, startTime);

		if (decision.audioTranscode) this.logger.debug("Transcoding audio", { sessionId });

		this.logger.debug(`Starting ${decision.mode} at ${startTime}s (seg ${startNumber})`, { sessionId, startTime, startNumber });

		// Reserve the streaming slot before reading the count so concurrent starts
		// cannot both compute threads from the same pre-spawn value.
		const releaseStreamingSlot = ffmpegProcessTracker.reserveStreaming();
		try {
			const configuredThreads = serverConfig.ffmpeg.threads;
			// Budget per process shrinks with concurrent transcodes — nothing else
			// corrects this (rescue never kills streaming processes).
			const activeTranscodes = ffmpegProcessTracker.countByPurpose("streaming");
			const threads = resolveStreamingThreads(configuredThreads, activeTranscodes);
			const hw = decision.videoTranscode && !decision.forceSoftware ? getEffectiveHwaccel() : undefined;
			if (decision.videoTranscode) {
				// The configured setting ("auto", "none") says nothing about what
				// encodes the stream — the effective accelerator and its encoder do.
				this.logger.debug("Transcoding video", {
					sessionId,
					accelerator: hw?.type ?? "none",
					encoder: hw?.h264Encoder ?? "libx264",
				});
			}
			// Resolve once and share between the input (zero-copy decision) and output
			// (filter chain) builders so both agree on whether tone-mapping will run.
			const toneMap = resolveToneMapConfig();

			const outputArgs = [
				"-threads",
				String(threads),
				...buildMetadataStripArgs(),
				...buildTranscodeVideoArgs(decision, this.config, hw, toneMap),
				...buildTranscodeAudioArgs(decision),
				...buildDecisionStreamMapArgs(decision),
				...buildHlsMuxerArgs(this.config, startNumber, segmentPattern),
			];

			// Probing flags, hardware input flags, then fast input seek. Order matters: FFmpeg
			// processes input args left-to-right before opening the input file.
			const inputArgs = [
				...this.buildProbeInputArgs(decision.formatName),
				...buildHwaccelInputArgs(decision, hw, toneMap),
				...(startTime > 0 ? ["-ss", startTime.toString()] : []),
			];

			// Encode to EOF — no `-t` output bound. A bounded lookahead window made
			// ffmpeg exit normally after ~clamped(speedFactor×120)s, the EVENT muxer
			// finalized the playlist with `#EXT-X-ENDLIST` mid-content and hls.js
			// stopped there; with the process dead, keepAlive stopped refreshing and
			// the inactivity reaper (30 s) deleted the session mid-watch.
			return this.runSession({
				sessionId,
				inputPath,
				outputDir,
				mode: "transcode",
				inputArgs,
				outputArgs,
				errorLogMessage: "FFmpeg stderr",
				operationId,
			});
		} finally {
			releaseStreamingSlot();
		}
	}
}
