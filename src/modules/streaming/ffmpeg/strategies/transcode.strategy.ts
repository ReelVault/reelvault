import type { PlaybackDecision } from "@sdk/common/stream.types";
import type { Subprocess } from "bun";
import { getEffectiveHwaccel, resolveToneMapConfig } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { buildHlsMuxerArgs, buildStreamMapArgs, segmentStartNumber } from "@/integrations/ffmpeg/ffmpeg.hls-muxer";
import { ffmpegProcessTracker } from "@/integrations/ffmpeg/ffmpeg.process-tracker";
import { buildHwaccelInputArgs, buildTranscodeAudioArgs, buildTranscodeVideoArgs } from "@/integrations/ffmpeg/ffmpeg.transcode-args";
import { probeBudgetForFormat } from "@/integrations/ffprobe/ffprobe.probe-budgets";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { NotFoundError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { clamp } from "@/utils/math.utils";
import { PathUtils } from "@/utils/path.utils";
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
	async startSession(
		sessionId: string,
		inputPath: string,
		outputDir: string,
		decision: PlaybackDecision,
		startTime = 0,
	): Promise<Subprocess> {
		if (!(await FileUtils.exists(inputPath))) {
			throw new NotFoundError(`Input file does not exist: ${inputPath}`);
		}

		const segmentPattern = PathUtils.join(outputDir, "seg_%d.m4s");
		const startNumber = segmentStartNumber(startTime, this.config);

		if (decision.audioTranscode) this.logger.debug("Transcoding audio", { sessionId });

		if (decision.videoTranscode) this.logger.debug("Transcoding video", { sessionId, hwaccel: serverConfig.ffmpeg.hwaccel });

		this.logger.debug(`Starting ${decision.mode} at ${startTime}s (seg ${startNumber})`, { sessionId, startTime, startNumber });

		// Reserve the streaming slot before reading the count so concurrent starts
		// cannot both compute threads from the same pre-spawn value.
		const releaseStreamingSlot = ffmpegProcessTracker.reserveStreaming();
		try {
			const configuredThreads = serverConfig.ffmpeg.threads;
			// Budget per process shrinks with concurrent transcodes — nothing else
			// corrects this (rescue never kills streaming processes).
			const activeTranscodes = ffmpegProcessTracker.countByPurpose("streaming");
			const threads =
				configuredThreads > 0
					? configuredThreads
					: clamp(Math.floor(systemResourcesService.getFfmpegThreads() / Math.max(1, activeTranscodes + 1)), 1, 8);
			const hw = decision.videoTranscode && !decision.forceSoftware ? getEffectiveHwaccel() : undefined;
			// Resolve once and share between the input (zero-copy decision) and output
			// (filter chain) builders so both agree on whether tone-mapping will run.
			const toneMap = resolveToneMapConfig();

			const outputArgs = [
				"-threads",
				String(threads),
				"-map_metadata",
				"-1",
				"-map_chapters",
				"-1",
				...buildTranscodeVideoArgs(decision, this.config, hw, toneMap),
				...buildTranscodeAudioArgs(decision),
				...buildStreamMapArgs(decision),
				...buildHlsMuxerArgs(this.config, startNumber, segmentPattern),
			];

			// Probing flags, hardware input flags, then fast input seek. Order matters: FFmpeg
			// processes input args left-to-right before opening the input file.
			const probeBudget = probeBudgetForFormat(decision.formatName);
			const inputArgs = [
				"-analyzeduration",
				probeBudget.analyzeduration,
				"-probesize",
				probeBudget.probesize,
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
			});
		} finally {
			releaseStreamingSlot();
		}
	}
}
