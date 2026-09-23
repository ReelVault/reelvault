import type { PlaybackDecision } from "@sdk/common/stream.types";
import type { Subprocess } from "bun";
import { buildDirectStreamOutputArgs } from "@/integrations/ffmpeg/ffmpeg.direct-stream-args";
import { segmentStartNumber } from "@/integrations/ffmpeg/ffmpeg.hls-muxer";
import { probeBudgetForFormat } from "@/integrations/ffprobe/ffprobe.probe-budgets";
import { NotFoundError } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
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
	): Promise<Subprocess> {
		if (!(await FileUtils.exists(inputPath))) {
			throw new NotFoundError(`Input file does not exist: ${inputPath}`);
		}

		const segmentPattern = PathUtils.join(outputDir, "seg_%d.m4s");
		const startNumber = segmentStartNumber(startTime, this.config);

		this.logger.debug(`Starting direct-stream at ${startTime}s (seg ${startNumber})`, { sessionId, startTime, startNumber });

		const outputArgs = buildDirectStreamOutputArgs(decision, this.config, startNumber, segmentPattern);

		const probeBudget = probeBudgetForFormat(decision.formatName);
		const inputArgs = [
			"-analyzeduration",
			probeBudget.analyzeduration,
			"-probesize",
			probeBudget.probesize,
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
		});
	}
}
