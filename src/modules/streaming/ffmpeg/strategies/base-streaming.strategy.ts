import type { TranscodeConfig } from "@reelvault/sdk/common";
import type { Subprocess } from "bun";
import { buildHlsOutputPath, segmentStartNumber } from "@/integrations/ffmpeg/ffmpeg.hls-muxer";
import { ffmpegProcessTracker } from "@/integrations/ffmpeg/ffmpeg.process-tracker";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { probeBudgetForFormat } from "@/integrations/ffprobe/ffprobe.probe-budgets";
import { transcodeProgressMonitor } from "@/modules/streaming/runtime/transcode-progress.monitor";
import type { StreamingStrategy, StreamStartInput } from "@/modules/streaming/streaming.types";
import { PLAYLIST_FILE_NAME, SEGMENT_OUTPUT_PATTERN } from "@/modules/streaming/utils/segment-name.utils";
import { DomainError } from "@/utils/domain.errors";
import { FileUtils } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { detach } from "@/utils/promise.utils";

/**
 * Shared plumbing for streaming strategies: the ffmpeg builder chain, progress
 * monitoring, exit logging and the playlist output path. Subclasses only build
 * their own input/output arguments.
 */
export abstract class BaseStreamingStrategy implements StreamingStrategy {
	readonly logger: ReturnType<typeof createLogger>;
	protected readonly config: TranscodeConfig;

	constructor(config: TranscodeConfig) {
		this.config = config;
		this.logger = createLogger(new.target.name);
	}

	abstract startSession(input: StreamStartInput): Promise<Subprocess>;

	/** Refuses to start when the input disappeared between selection and spawn. */
	protected async assertInputExists(inputPath: string): Promise<void> {
		if (!(await FileUtils.exists(inputPath))) {
			throw new DomainError("not_found", `Input file does not exist: ${inputPath}`, { code: "media_file.missing" });
		}
	}

	/** Segment output pattern + start number shared by every strategy's output args. */
	protected resolveSegmentOutput(outputDir: string, startTime: number): { segmentPattern: string; startNumber: number } {
		return {
			segmentPattern: buildHlsOutputPath(outputDir, SEGMENT_OUTPUT_PATTERN),
			startNumber: segmentStartNumber(startTime, this.config),
		};
	}

	/** Session prelude shared by every strategy: refuse a vanished input, then resolve the segment output. */
	protected async prepareSession(
		inputPath: string,
		outputDir: string,
		startTime: number,
	): Promise<{ segmentPattern: string; startNumber: number }> {
		await this.assertInputExists(inputPath);

		return this.resolveSegmentOutput(outputDir, startTime);
	}

	/** `-analyzeduration`/`-probesize` input flags sized by container format. */
	protected buildProbeInputArgs(formatName: string | null | undefined): string[] {
		const probeBudget = probeBudgetForFormat(formatName);

		return ["-analyzeduration", probeBudget.analyzeduration, "-probesize", probeBudget.probesize];
	}

	protected runSession({
		sessionId,
		inputPath,
		outputDir,
		mode,
		inputArgs,
		outputArgs,
		errorLogMessage,
		operationId,
	}: {
		sessionId: string;
		inputPath: string;
		outputDir: string;
		mode: "direct-stream" | "transcode";
		inputArgs: string[];
		outputArgs: string[];
		errorLogMessage: string;
		operationId?: string | undefined;
	}): Subprocess {
		// Held so the exit callback can hand the monitor the exact process: an exit
		// from a replaced process must not close the operation of a newer one.
		const handle: { process?: Subprocess } = {};
		const subprocess = ffMpegService
			.create()
			.inputArgs(inputArgs)
			.input(inputPath)
			.outputArgs(outputArgs)
			// The worker operation id is what diagnostics/admin show; fall back to
			// the session id only for sessions without an operation.
			.withOperationLog({ operationId: operationId ?? sessionId, mode, inputPath })
			.purpose("streaming")
			.label(sessionId)
			.onError((err) => {
				// During a graceful stop ffmpeg reports broken pipes / unwritable
				// outputs on stderr — noise unless the process died for real.
				if (ffmpegProcessTracker.isIntentionalKill(sessionId))
					this.logger.debug("FFmpeg reported stderr error during intentional stop", { sessionId });
				else this.logger.error(errorLogMessage, err, { sessionId });
			})
			.onProgress((progress) => detach(transcodeProgressMonitor.onFfmpegProgress(sessionId, progress)))
			.onExit((_, exitCode, signalCode, error) => {
				const intentional = ffmpegProcessTracker.isIntentionalKill(sessionId);
				ffmpegProcessTracker.clearIntentionalKill(sessionId);

				if (exitCode === 0) this.logger.debug("FFmpeg process completed successfully", { sessionId, mode });
				else if (intentional || signalCode != null) this.logger.warn("FFmpeg process stopped", { sessionId, mode, exitCode, signalCode });
				else this.logger.error("FFmpeg process exited with error", error, { sessionId, exitCode, signalCode });

				detach(transcodeProgressMonitor.onFfmpegExit(sessionId, exitCode, signalCode, handle.process));
			})
			.run(buildHlsOutputPath(outputDir, PLAYLIST_FILE_NAME));
		handle.process = subprocess;

		return subprocess;
	}
}
