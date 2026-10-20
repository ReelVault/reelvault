import type { Subprocess } from "bun";
import type { DownloadQuality } from "@/integrations/drizzle-orm/constants/downloads.constants";
import { killFfmpegProcessGracefully } from "@/integrations/ffmpeg/ffmpeg.process";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { buildDownloadOutputArgs, ffmpegTimeToSeconds } from "@/modules/downloads/download-quality.utils";
import { downloadsStorage } from "@/modules/downloads/downloads.ports";
import type { DownloadRunOptions, DownloadsServiceState } from "@/modules/downloads/shared.utils";
import { errorMessage } from "@/utils/domain.errors";
import { clamp } from "@/utils/math.utils";
import { detachCatching } from "@/utils/promise.utils";

/** Progress writes must never reject into ffmpeg's callbacks: a failure is logged and the run goes on. */
function reportProgress(
	state: DownloadsServiceState,
	downloadId: string,
	percent: number,
	message: string,
	step: () => Promise<unknown>,
): void {
	detachCatching(step(), (error) => state.logger.warn(message, { downloadId, percent, error: errorMessage(error) }));
}

/** Runs ffmpeg into `outputPath`; resolves with the exit code, or rejects when the process itself fails. */
export function runFfmpeg(
	state: DownloadsServiceState,
	params: {
		downloadId: string;
		filePath: string;
		durationSeconds: number;
		quality: DownloadQuality;
		outputPath: string;
		options: DownloadRunOptions;
	},
): Promise<number | null> {
	const { downloadId, filePath, durationSeconds, quality, outputPath, options } = params;
	const procRef: { current: Subprocess | undefined } = { current: undefined };
	const killProc = () => {
		const running = procRef.current;
		if (!running) return;

		// SIGTERM first, SIGKILL after the grace period: a plain kill left ffmpeg
		// alive on a stalled mount, so the cancelled download kept burning CPU
		// and holding the disk.
		detachCatching(killFfmpegProcessGracefully(running));
	};
	state.abortHandles.set(downloadId, killProc);
	if (options.signal?.aborted) {
		// Aborted after load but before spawn — killProc is a no-op here, so
		// without this check ffmpeg would run to completion unstoppably.
		state.abortHandles.delete(downloadId);

		return Promise.reject(new Error("Download aborted before start"));
	}

	if (options.signal) options.signal.addEventListener("abort", killProc, { once: true });

	// ffmpeg emits progress far more often than a whole-percent display changes.
	// One tick previously cost three UPDATEs (download row + job + operation);
	// report only on whole-percent changes — ≤100 writes for any duration.
	let reportedPercent = -1;

	return new Promise<number | null>((resolve, reject) => {
		const builder = ffMpegService
			.create()
			.input(filePath)
			.outputArgs(buildDownloadOutputArgs(quality, durationSeconds))
			.onProgress((progress) => {
				if (durationSeconds <= 0) return;

				const percent = clamp((ffmpegTimeToSeconds(progress.time) / durationSeconds) * 100, 0, 99);
				const wholePercent = Math.floor(percent);
				if (wholePercent === reportedPercent) return;

				reportedPercent = wholePercent;
				reportProgress(state, downloadId, percent, "Download progress persistence failed", () =>
					downloadsStorage().update(downloadId, { progressPercent: percent }),
				);
				reportProgress(state, downloadId, percent, "Download progress callback failed", async () => {
					await options.updateProgress?.(percent);
				});
			})
			.onExit((_subprocess, code, _signal, error) => {
				if (error) reject(error);
				else resolve(code);
			});
		procRef.current = builder.run(outputPath);
	}).finally(() => {
		if (options.signal) options.signal.removeEventListener("abort", killProc);
	});
}
