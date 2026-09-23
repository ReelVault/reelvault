import type { PlaybackDecision, TranscodeConfig } from "@sdk/common/stream.types";
import type { Subprocess } from "bun";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { createLogger } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";
import { detach } from "@/utils/promise.utils";
import { transcodeProgressMonitor } from "../../runtime/transcode-progress.monitor";
import type { StreamingStrategy } from "../../streaming.types";

/**
 * Shared plumbing for streaming strategies: the ffmpeg builder chain, progress
 * monitoring, exit logging and the playlist output path. Subclasses only build
 * their own input/output arguments.
 */
export abstract class BaseStreamingStrategy implements StreamingStrategy {
	protected readonly logger: ReturnType<typeof createLogger>;
	protected readonly config: TranscodeConfig;

	constructor(config: TranscodeConfig) {
		this.config = config;
		this.logger = createLogger(new.target.name);
	}

	abstract startSession(
		sessionId: string,
		inputPath: string,
		outputDir: string,
		decision: PlaybackDecision,
		startTime?: number,
	): Promise<Subprocess>;

	protected runSession({
		sessionId,
		inputPath,
		outputDir,
		mode,
		inputArgs,
		outputArgs,
		errorLogMessage,
	}: {
		sessionId: string;
		inputPath: string;
		outputDir: string;
		mode: "direct-stream" | "transcode";
		inputArgs: string[];
		outputArgs: string[];
		errorLogMessage: string;
	}): Subprocess {
		return ffMpegService
			.create()
			.inputArgs(inputArgs)
			.input(inputPath)
			.outputArgs(outputArgs)
			.withOperationLog({ operationId: sessionId, mode, inputPath })
			.purpose("streaming")
			.label(sessionId)
			.onError((err) => this.logger.error(errorLogMessage, err, { sessionId }))
			.onProgress((progress) => detach(transcodeProgressMonitor.onFfmpegProgress(sessionId, progress)))
			.onExit((_, exitCode, signalCode, error) => {
				if (exitCode !== 0) this.logger.error("FFmpeg process exited with error", error, { sessionId, exitCode });
				else this.logger.debug("FFmpeg process completed successfully", { sessionId, mode });

				detach(transcodeProgressMonitor.onFfmpegExit(sessionId, exitCode, signalCode));
			})
			.run(PathUtils.join(outputDir, "playlist.m3u8"));
	}
}
