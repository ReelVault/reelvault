import type { PlaybackDecision } from "@reelvault/sdk/common";
import type { Subprocess } from "bun";
import { buildDirectStreamOutputArgs } from "@/integrations/ffmpeg/ffmpeg.direct-stream-args";
import { BaseStreamingStrategy } from "./base-streaming.strategy";

/**
 * Remuxes compatible video/audio into fMP4 HLS with `-c copy` (no re-encoding).
 *
 * Fast input seek (`-ss` with `-noaccurate_seek` before `-i`) jumps directly to
 * the nearest keyframe without software-decoding preceding frames, which provides
 * near-instant stream start and fast-seek response even on older CPUs.
 *
 * `-fflags +genpts` generates missing PTS for MKV containers ensuring monotonic
 * timestamps for fMP4 muxing.
 */
export class DirectStreamStrategy extends BaseStreamingStrategy {
	async startSession(
		sessionId: string,
		inputPath: string,
		outputDir: string,
		decision: PlaybackDecision,
		startTime = 0,
		operationId?: string,
	): Promise<Subprocess> {
		const { segmentPattern, startNumber } = await this.prepareSession(inputPath, outputDir, startTime);

		this.logger.debug(`Starting direct-stream at ${startTime}s (seg ${startNumber})`, { sessionId, startTime, startNumber });

		const outputArgs = buildDirectStreamOutputArgs(decision, this.config, startNumber, segmentPattern);

		const inputArgs = [
			...this.buildProbeInputArgs(decision.formatName),
			"-fflags",
			"+genpts",
			...(startTime > 0 ? ["-ss", startTime.toString(), "-noaccurate_seek"] : []),
		];

		return this.runSession({
			sessionId,
			inputPath,
			outputDir,
			mode: "direct-stream",
			inputArgs,
			outputArgs,
			errorLogMessage: "FFmpeg process error",
			operationId,
		});
	}
}
