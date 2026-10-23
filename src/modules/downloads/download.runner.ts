import { join } from "node:path";
import type { Logger } from "@reelvault/sdk";
import { file, type Subprocess } from "bun";
import { serverConfig } from "@/config/server/server.config";
import type { DownloadQuality } from "@/integrations/drizzle-orm/constants/downloads.constants";
import { parseFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { killFfmpegProcessGracefully } from "@/integrations/ffmpeg/ffmpeg.process";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { type DownloadRow, downloadsRepository } from "@/repositories/downloads.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import { createDirectory } from "@/utils/directory.utils";
import { DomainError, errorMessage } from "@/utils/domain.errors";
import { clamp } from "@/utils/math.utils";
import { detachCatching } from "@/utils/promise.utils";
import { deleteDownloadOutput, downloadDirectory, downloadFileName } from "./download-files.utils";
import { buildDownloadOutputArgs, ffmpegTimeToSeconds } from "./download-quality.utils";

/** What a run shares with the service: its logger and the kill-switches of in-flight ffmpeg runs, keyed by download id. */
export interface DownloadRunContext {
	readonly logger: Logger;
	readonly abortHandles: Map<string, () => void>;
}

/** Options of one worker run: a progress sink, and the signal that stops ffmpeg. */
export interface DownloadRunOptions {
	updateProgress?: (percent: number) => Promise<void>;
	signal?: AbortSignal;
}

/** A pending download with the source file it transcodes. */
export interface PendingDownload {
	row: DownloadRow;
	filePath: string;
	durationSeconds: number;
	sourceFileName: string;
}

/** The media file fields a download reads: where it lives, its length and its name. */
export async function findDownloadSource(mediaFileId: string) {
	return await mediaRepository.findByPrimaryId({
		primaryId: mediaFileId,
		fields: parseFields({ fields: "id,filePath,duration,fileName" }),
	});
}

/** Fails a download whose source media file disappeared — retrying cannot bring it back. */
export async function failMissingSource(downloadId: string): Promise<boolean> {
	return await downloadsRepository.failIfActive(downloadId, "download.media_missing");
}

/** The download and its source, when it still waits to run; a missing source fails it instead of leaving it `pending`. */
export async function loadPendingDownload(downloadId: string): Promise<PendingDownload | null> {
	const row = await downloadsRepository.findById(downloadId);
	if (!row) throw new DomainError("not_found", `Download not found: ${downloadId}`, { code: "download_not_found" });

	if (row.status !== "pending") return null;

	const mediaFile = await findDownloadSource(row.mediaFileId);
	if (!mediaFile?.filePath) {
		// Retrying cannot bring the file back, and leaving the row `pending`
		// pinned the profile's single active-download slot forever.
		await failMissingSource(downloadId);

		return null;
	}

	return { row, filePath: mediaFile.filePath, durationSeconds: mediaFile.duration ?? 0, sourceFileName: mediaFile.fileName };
}

/** The live ffmpeg process of one run; `aborted` stays set when cancellation arrives before the spawn. */
interface DownloadProcessState {
	current: Subprocess | undefined;
	aborted: boolean;
}

/**
 * Runs a download that holds a running slot: ffmpeg MP4 (faststart) → completed.
 * A `cancelled` row written mid-run makes the exit handler drop the partial file
 * instead of marking completion. A run that throws hands its slot back (`pending`),
 * so the worker's retry can claim it again and its last attempt can mark it failed.
 */
export async function runClaimedDownload(
	context: DownloadRunContext,
	pending: PendingDownload,
	options: DownloadRunOptions,
): Promise<void> {
	const { row, filePath, durationSeconds, sourceFileName } = pending;
	const processState: DownloadProcessState = { current: undefined, aborted: false };
	const abortProcess = () => {
		processState.aborted = true;
		const running = processState.current;
		if (!running) return;

		// SIGTERM first, SIGKILL after the grace period: a plain kill left ffmpeg
		// alive on a stalled mount, so the cancelled download kept burning CPU
		// and holding the disk.
		detachCatching(killFfmpegProcessGracefully(running));
	};
	// Register before output preparation: a cancellation during that work must
	// still stop the run before ffmpeg starts.
	context.abortHandles.set(row.id, abortProcess);

	try {
		const outputPath = await prepareOutput(row.id, row.quality, sourceFileName);
		if (processState.aborted) {
			await deleteDownloadOutput(outputPath);

			return;
		}

		const exitCode = await runFfmpeg(context, {
			downloadId: row.id,
			filePath,
			durationSeconds,
			quality: row.quality,
			outputPath,
			options,
			processState,
			abortProcess,
		});
		await finalizeDownload({ downloadId: row.id, profileId: row.profileId, quality: row.quality, outputPath, exitCode });
	} catch (error) {
		await downloadsRepository.releaseClaim(row.id);
		throw error;
	} finally {
		context.abortHandles.delete(row.id);
	}
}

async function prepareOutput(downloadId: string, quality: string, sourceFileName: string): Promise<string> {
	const fileName = downloadFileName(sourceFileName, quality);
	const outputDir = downloadDirectory(downloadId);

	// awaits: sequential — the output directory exists before the file name is recorded
	await createDirectory(outputDir);
	await downloadsRepository.update(downloadId, { fileName });

	return join(outputDir, fileName);
}

/** Progress writes must never reject into ffmpeg's callbacks: a failure is logged and the run goes on. */
function reportProgress(
	context: DownloadRunContext,
	downloadId: string,
	percent: number,
	message: string,
	step: () => Promise<unknown>,
): void {
	detachCatching(step(), (error) => context.logger.warn(message, { downloadId, percent, error: errorMessage(error) }));
}

/** Runs ffmpeg into `outputPath`; resolves with the exit code, or rejects when the process itself fails. */
function runFfmpeg(
	context: DownloadRunContext,
	params: {
		downloadId: string;
		filePath: string;
		durationSeconds: number;
		quality: DownloadQuality;
		outputPath: string;
		options: DownloadRunOptions;
		processState: DownloadProcessState;
		abortProcess: () => void;
	},
): Promise<number | null> {
	const { downloadId, filePath, durationSeconds, quality, outputPath, options, processState, abortProcess } = params;
	// Aborted after load but before spawn — a cancellation can arrive while the output is prepared.
	if (processState.aborted || options.signal?.aborted) return Promise.reject(new Error("Download aborted before start"));

	options.signal?.addEventListener("abort", abortProcess, { once: true });

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
				reportProgress(context, downloadId, percent, "Download progress persistence failed", () =>
					downloadsRepository.update(downloadId, { progressPercent: percent }),
				);
				reportProgress(context, downloadId, percent, "Download progress callback failed", async () => {
					await options.updateProgress?.(percent);
				});
			})
			.onExit((_subprocess, code, _signal, error) => {
				if (error) reject(error);
				else resolve(code);
			});
		processState.current = builder.run(outputPath);
	}).finally(() => {
		options.signal?.removeEventListener("abort", abortProcess);
	});
}

async function finalizeDownload(params: {
	downloadId: string;
	profileId: string;
	quality: DownloadQuality;
	outputPath: string;
	exitCode: number | null;
}): Promise<void> {
	const { downloadId, profileId, quality, outputPath, exitCode } = params;

	const fresh = await downloadsRepository.findById(downloadId);
	if (fresh?.status === "cancelled") {
		await deleteDownloadOutput(outputPath);

		return;
	}

	if (exitCode !== 0) {
		await failFinalizing(downloadId, outputPath, quality === "original" ? "download.source_not_mp4" : "download.ffmpeg_failed");

		return;
	}

	const sizeBytes = file(outputPath).size;
	if (sizeBytes === 0) {
		await failFinalizing(downloadId, outputPath, "download.empty_output");

		return;
	}

	const maxBytes = serverConfig.downloads.maxStorageBytesPerProfile;
	const usedBytes = await downloadsRepository.storageUsedByProfile(profileId);
	if (maxBytes > 0 && usedBytes + sizeBytes > maxBytes) {
		await failFinalizing(downloadId, outputPath, "download.storage_limit");

		return;
	}

	if (!(await downloadsRepository.completeProcessing(downloadId, sizeBytes))) await deleteOutputUnlessCompleted(downloadId, outputPath);
}

/** Drops the partial output and records why the download failed. */
async function failFinalizing(downloadId: string, outputPath: string, errorText: string): Promise<void> {
	if (await downloadsRepository.failIfActive(downloadId, errorText)) {
		await deleteDownloadOutput(outputPath);

		return;
	}

	await deleteOutputUnlessCompleted(downloadId, outputPath);
}

/** A failed or cancelled finalization owns the partial file; a completed row keeps it. */
async function deleteOutputUnlessCompleted(downloadId: string, outputPath: string): Promise<void> {
	const row = await downloadsRepository.findById(downloadId);
	if (row?.status !== "completed") await deleteDownloadOutput(outputPath);
}
