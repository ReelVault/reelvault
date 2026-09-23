import { rm } from "node:fs/promises";
import { file, type Subprocess } from "bun";
import { type DownloadRow, downloadsRepository } from "@/database/repositories/downloads.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { QueryFields } from "@/database/utils/fields";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { buildDownloadOutputArgs, ffmpegTimeToSeconds, isDownloadQuality } from "@/modules/downloads/download-quality.utils";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { DirUtils } from "@/utils/directory.utils";
import { errorMessage, NotFoundError, ValidationError } from "@/utils/errors";
import { clamp } from "@/utils/math.utils";
import { PathUtils } from "@/utils/path.utils";
import { detach } from "@/utils/promise.utils";
import { enqueueDownloadsProcess } from "@/workers/definitions/downloads/downloads-process.worker";

export interface DownloadJobView {
	id: string;
	mediaFileId: string;
	quality: string;
	status: string;
	progressPercent: number;
	sizeBytes: number | null;
	fileName: string | null;
	downloadUrl: string | null;
	errorText: string | null;
	createdAt: string;
	updatedAt: string;
}

/** Max simultaneously processing downloads per profile — one ffmpeg is plenty. */
const MAX_ACTIVE_PER_PROFILE = 1;
const RETENTION_SWEEP_FIRST_DELAY_MS = 60_000;
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FILE_EXTENSION_REGEX = /\.[^.]+$/;
const ILLEGAL_FILENAME_CHARS_REGEX = /["\\/:*?<>|]+/g;

function mediaFileBaseName(sourceFileName: string): string {
	return sourceFileName.replace(FILE_EXTENSION_REGEX, "").replace(ILLEGAL_FILENAME_CHARS_REGEX, "_").slice(0, 120) || "download";
}

class DownloadsService extends BaseService {
	/** Kill-switches for in-flight ffmpeg runs, keyed by download id. */
	private readonly abortHandles = new Map<string, () => void>();
	private retentionTimerStarted = false;

	constructor() {
		super("DownloadsService");
		this.scheduleRetentionSweep();
	}

	async prepare(profileId: string | undefined, mediaFileId: string, quality = "720p-mobile"): Promise<DownloadJobView> {
		return await this.safeExecute("prepare", async () => {
			this.assertExists(profileId, "Profile", "auth");
			if (!serverConfig.downloads.enabled) throw new ValidationError("Downloads are disabled on this server");

			if (!mediaFileId.trim()) throw new ValidationError("mediaFileId is required");

			const mediaFile = await mediaRepository.findByPrimaryId({
				primaryId: mediaFileId,
				fields: QueryFields.parse({ fields: "id,filePath,duration,fileName" }),
			});
			this.assertExists(mediaFile, "MediaFile", mediaFileId);
			if (quality !== "original" && !(mediaFile.duration && mediaFile.duration > 0)) {
				throw new ValidationError("Transcoded download requires a known file duration");
			}

			if ((await downloadsRepository.countActiveByProfile(profileId)) >= MAX_ACTIVE_PER_PROFILE) {
				throw new ValidationError("This profile already has a download in progress");
			}

			const usedBytes = await downloadsRepository.storageUsedByProfile(profileId);
			const maxBytes = serverConfig.downloads.maxStorageBytesPerProfile;
			if (maxBytes > 0 && usedBytes >= maxBytes) {
				throw new ValidationError("Storage quota exceeded — delete older downloads first");
			}

			const row = await downloadsRepository.insert({
				profileId,
				mediaFileId,
				quality: isDownloadQuality(quality) ? quality : "720p-mobile",
			});
			await enqueueDownloadsProcess(row.id);

			return this.toView(row);
		});
	}

	async list(profileId: string): Promise<{ jobs: DownloadJobView[] }> {
		const rows = await downloadsRepository.findByProfile(profileId);

		return { jobs: rows.map((row) => this.toView(row)) };
	}

	async listAll(): Promise<{ jobs: Array<DownloadJobView & { profileId: string }> }> {
		const rows = await downloadsRepository.findAll();

		return { jobs: rows.map((row) => ({ ...this.toView(row), profileId: row.profileId })) };
	}

	/** Ownership-checked variants — a profile only ever sees its own jobs. */
	async getJobViewForProfile(jobId: string, profileId: string): Promise<DownloadJobView | null> {
		const row = await this.getOwnedDownload(jobId, profileId);

		return row ? this.toView(row) : null;
	}

	async cancelForProfile(jobId: string, profileId: string): Promise<{ success: true }> {
		await this.assertOwnedDownload(jobId, profileId);

		return this.cancel(jobId);
	}

	async deleteForProfile(jobId: string, profileId: string): Promise<{ success: true }> {
		await this.assertOwnedDownload(jobId, profileId);

		return this.delete(jobId);
	}

	async resolveFileForProfile(jobId: string, profileId: string): Promise<{ fileName: string; blob: Blob } | null> {
		const row = await this.getOwnedDownload(jobId, profileId);

		return row ? this.resolveFile(jobId) : null;
	}

	async cancel(downloadId: string): Promise<{ success: true }> {
		const row = await downloadsRepository.findById(downloadId);
		if (!row) throw new NotFoundError("Download not found", { code: "download_not_found" });

		if (row.status === "completed")
			throw new ValidationError("Completed download cannot be cancelled", { code: "completed_download_cancel" });

		const kill = this.abortHandles.get(downloadId);
		if (kill) kill();

		await downloadsRepository.update(downloadId, { status: "cancelled" });
		await this.deleteArtifactFile(row);

		return { success: true };
	}

	async delete(downloadId: string): Promise<{ success: true }> {
		const row = await downloadsRepository.findById(downloadId);
		if (row) {
			this.abortHandles.get(downloadId)?.();
			await this.deleteArtifactFile(row);
			await downloadsRepository.delete(downloadId);
		}

		return { success: true };
	}

	/** Completed download as a file handle — never exposes the storage path. */
	async resolveFile(downloadId: string): Promise<{ fileName: string; blob: Blob } | null> {
		const row = await downloadsRepository.findById(downloadId);
		if (row?.status !== "completed" || !row.fileName) return null;

		const path = this.artifactPath(downloadId, row.fileName);
		const handle = file(path);
		if (!(await handle.exists())) return null;

		return { fileName: row.fileName, blob: handle };
	}

	private artifactPath(downloadId: string, fileName: string): string {
		return PathUtils.join(serverConfig.paths.downloads, downloadId, fileName);
	}

	private async getOwnedDownload(jobId: string, profileId: string): Promise<DownloadRow | null> {
		const row = await downloadsRepository.findById(jobId);
		if (!row || row.profileId !== profileId) return null;

		return row;
	}

	private async assertOwnedDownload(jobId: string, profileId: string): Promise<DownloadRow> {
		const row = await downloadsRepository.findById(jobId);
		if (!row || row.profileId !== profileId) throw new NotFoundError("Download not found", { code: "download_not_found" });

		return row;
	}

	private async deleteArtifactFile(row: DownloadRow): Promise<void> {
		if (!row.fileName) return;

		await this.deleteArtifact(this.artifactPath(row.id, row.fileName));
	}

	/** Deletes a download artifact under serverConfig.paths.downloads.
	 * FileUtils.delete refuses every video extension (library protection), which
	 * would silently orphan every .mp4 artifact here — downloads own this
	 * directory, so the removal bypasses that guard on purpose. */
	private async deleteArtifact(path: string): Promise<void> {
		await rm(path, { force: true });
	}

	/**
	 * Runs one download job inside the worker: pending → processing → ffmpeg MP4
	 * (faststart) → completed. A `cancelled` row written mid-run makes the exit
	 * handler drop the partial file instead of marking completion.
	 */
	async process(
		downloadId: string,
		options: { updateProgress?: (percent: number) => Promise<void>; signal?: AbortSignal } = {},
	): Promise<void> {
		const context = await this.loadPendingDownload(downloadId);
		if (!context) return;

		const { row, filePath, durationSeconds } = context;

		const outputPath = await this.resolveOutputPath(downloadId, row.quality, context.sourceFileName);

		try {
			const exitCode = await this.runFfmpeg({ downloadId, filePath, durationSeconds, quality: row.quality, outputPath, options });
			await this.finalizeDownload({ downloadId, profileId: row.profileId, quality: row.quality, outputPath, exitCode });
		} finally {
			this.abortHandles.delete(downloadId);
		}
	}

	private async loadPendingDownload(downloadId: string): Promise<{
		row: DownloadRow;
		filePath: string;
		durationSeconds: number;
		sourceFileName: string;
	} | null> {
		const row = await downloadsRepository.findById(downloadId);
		if (!row) throw new NotFoundError(`Download not found: ${downloadId}`, { code: "download_not_found" });

		if (row.status !== "pending") return null;

		const mediaFile = await mediaRepository.findByPrimaryId({
			primaryId: row.mediaFileId,
			fields: QueryFields.parse({ fields: "id,filePath,duration,fileName" }),
		});
		this.assertExists(
			mediaFile,
			"MediaFile",
			row.mediaFileId,
			() => new NotFoundError(`Media file not found: ${row.mediaFileId}`, { code: "media_file_not_found" }),
		);
		if (!mediaFile.filePath) throw new NotFoundError(`Media file not found: ${row.mediaFileId}`, { code: "media_file_not_found" });

		return { row, filePath: mediaFile.filePath, durationSeconds: mediaFile.duration ?? 0, sourceFileName: mediaFile.fileName };
	}

	private async resolveOutputPath(downloadId: string, quality: string, sourceFileName: string): Promise<string> {
		const baseName = mediaFileBaseName(sourceFileName);
		const fileName = `${baseName}.${quality === "original" ? "mp4" : `${quality}.mp4`}`;
		const outputDir = PathUtils.join(serverConfig.paths.downloads, downloadId);
		await DirUtils.create(outputDir);
		const outputPath = PathUtils.join(outputDir, fileName);
		await downloadsRepository.update(downloadId, { status: "processing", fileName });

		return outputPath;
	}

	private runFfmpeg(params: {
		downloadId: string;
		filePath: string;
		durationSeconds: number;
		quality: Parameters<typeof buildDownloadOutputArgs>[0];
		outputPath: string;
		options: { updateProgress?: (percent: number) => Promise<void>; signal?: AbortSignal };
	}): Promise<number | null> {
		const { downloadId, filePath, durationSeconds, quality, outputPath, options } = params;
		const procRef: { current: Subprocess | undefined } = { current: undefined };
		const killProc = () => {
			try {
				procRef.current?.kill();
			} catch {
				// intentionally empty
			}
		};
		this.abortHandles.set(downloadId, killProc);
		if (options.signal?.aborted) {
			// Aborted after load but before spawn — killProc is a no-op here, so
			// without this check ffmpeg would run to completion unstoppably.
			this.abortHandles.delete(downloadId);

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

					detach(
						(async () => {
							try {
								await downloadsRepository.update(downloadId, { progressPercent: percent });
							} catch (error) {
								this.logger.warn("Download progress persistence failed", { downloadId, percent, error: errorMessage(error) });
							}
						})(),
					);
					detach(
						(async () => {
							try {
								await options.updateProgress?.(percent);
							} catch (error) {
								this.logger.warn("Download progress callback failed", { downloadId, percent, error: errorMessage(error) });
							}
						})(),
					);
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

	private async finalizeDownload(params: {
		downloadId: string;
		profileId: string;
		quality: Parameters<typeof buildDownloadOutputArgs>[0];
		outputPath: string;
		exitCode: number | null;
	}): Promise<void> {
		const { downloadId, profileId, quality, outputPath, exitCode } = params;

		const fresh = await downloadsRepository.findById(downloadId);
		if (fresh?.status === "cancelled") {
			await this.deleteArtifact(outputPath);

			return;
		}

		if (exitCode !== 0) {
			await this.deleteArtifact(outputPath);
			if (quality === "original") {
				await downloadsRepository.update(downloadId, {
					status: "failed",
					errorText: "The source is not MP4-compatible — pick a quality to scale it down.",
				});
			} else {
				await downloadsRepository.update(downloadId, { status: "failed", errorText: `FFmpeg exited with code ${exitCode ?? "unknown"}` });
			}

			return;
		}

		const output = file(outputPath);
		const sizeBytes = output.size;
		if (sizeBytes === 0) {
			await this.deleteArtifact(outputPath);
			await downloadsRepository.update(downloadId, { status: "failed", errorText: "FFmpeg produced an empty file" });

			return;
		}

		const maxBytes = serverConfig.downloads.maxStorageBytesPerProfile;
		const used = await downloadsRepository.storageUsedByProfile(profileId);
		if (maxBytes > 0 && used + sizeBytes > maxBytes) {
			await this.deleteArtifact(outputPath);
			await downloadsRepository.update(downloadId, {
				status: "failed",
				errorText: "The file exceeded the profile's storage limit — remove older downloads.",
			});

			return;
		}

		await downloadsRepository.update(downloadId, { status: "completed", progressPercent: 100, sizeBytes });
	}

	/** Deletes completed/failed/cancelled downloads older than the retention window. */
	async sweepExpired(): Promise<{ removed: number }> {
		const retentionDays = serverConfig.downloads.retentionDays;
		if (retentionDays <= 0) return { removed: 0 };

		let removed = 0;
		// Loop until a short page comes back — retention may span thousands of rows.
		for (;;) {
			const expired = await downloadsRepository.findExpired(retentionDays);
			if (expired.length === 0) break;

			let progressed = false;
			for (const row of expired) {
				// One EBUSY/EACCES must not abort the whole sweep (the old code threw
				// and the loop never advanced).
				try {
					await this.deleteArtifactFile(row);
					await downloadsRepository.delete(row.id);
					removed++;
					progressed = true;
				} catch (error) {
					this.logger.warn("Retention sweep failed for a download", { downloadId: row.id, error: errorMessage(error) });
				}
			}

			// No row could be removed → stop instead of re-fetching the same page forever.
			if (!progressed || expired.length < 500) break;
		}

		if (removed > 0) this.logger.info("Retention sweep removed downloads", { removed });

		return { removed };
	}

	private scheduleRetentionSweep(): void {
		if (this.retentionTimerStarted) return;

		this.retentionTimerStarted = true;
		const sweep = () => {
			detach(
				(async () => {
					try {
						await this.sweepExpired();
					} catch (error) {
						this.logger.warn("Retention sweep failed", { error });
					}
				})(),
			);
		};
		setTimeout(sweep, RETENTION_SWEEP_FIRST_DELAY_MS).unref();
		setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS).unref();
	}

	private toView(row: DownloadRow): DownloadJobView {
		return {
			id: row.id,
			mediaFileId: row.mediaFileId,
			quality: row.quality,
			status: row.status,
			progressPercent: row.progressPercent,
			sizeBytes: row.sizeBytes,
			fileName: row.fileName,
			downloadUrl: row.status === "completed" ? `/v1/downloads/${row.id}/file` : null,
			errorText: row.errorText,
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
	}
}

export const downloadsService = new DownloadsService();
