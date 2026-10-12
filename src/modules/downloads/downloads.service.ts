import { readdir, rm } from "node:fs/promises";
import type { BulkRefreshItem } from "@reelvault/sdk/common";
import { file, type Subprocess } from "bun";
import { type DownloadRow, downloadsRepository } from "@/database/repositories/downloads.repository";
import { episodesRepository } from "@/database/repositories/episodes.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { seasonsRepository } from "@/database/repositories/seasons.repository";
import { QueryFields } from "@/database/utils/fields";
import { QueryPagination } from "@/database/utils/pagination";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import {
	buildDownloadOutputArgs,
	DEFAULT_DOWNLOAD_QUALITY,
	type DownloadStatus,
	ffmpegTimeToSeconds,
	isDownloadQuality,
} from "@/modules/downloads/download-quality.utils";
import { serverConfig } from "@/server.config";
import { DirUtils } from "@/utils/directory.utils";
import { assertFound, assertProfileId, DomainError, errorCodeOf, errorMessage, isMissingFile, toErrorCode } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { clamp } from "@/utils/math.utils";
import { PathUtils } from "@/utils/path.utils";
import { detach } from "@/utils/promise.utils";
import { runSafely } from "@/utils/safe-execute";
import { enqueueDownloadsProcess } from "@/workers/definitions/downloads/downloads-process.worker";

export interface DownloadJobView {
	id: string;
	mediaFileId: string;
	/** Title the media file belongs to; null when it no longer has one. */
	metadataId: string | null;
	quality: string;
	status: string;
	progressPercent: number;
	sizeBytes: number | null;
	fileName: string | null;
	downloadUrl: string | null;
	errorCode: string | null;
	createdAt: string;
	updatedAt: string;
}

/** Retry sweep cadence — first pass shortly after boot, then daily. */
const RETENTION_SWEEP_FIRST_DELAY_MS = 60_000;
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FILE_EXTENSION_REGEX = /\.[^.]+$/;
const ILLEGAL_FILENAME_CHARS_REGEX = /["\\/:*?<>|]+/g;
/** Artifact directories are named after their download id, a UUID; anything else under the root is left alone. */
const DOWNLOAD_ID_DIRECTORY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORPHAN_SWEEP_BATCH_SIZE = 500;
/** Most downloads one profile may have waiting for a running slot; a request beyond it is refused. */
const MAX_QUEUED_DOWNLOADS_PER_PROFILE = 200;

interface SeasonFileCandidate {
	mediaFileId: string;
	isDefault: boolean;
	sizeBytes: number;
}

/** The default file of an episode wins; otherwise the first file seen is kept. */
function preferDefaultFile(current: SeasonFileCandidate | null, candidate: SeasonFileCandidate | null): SeasonFileCandidate | null {
	if (!current) return candidate;
	if (candidate?.isDefault && !current.isDefault) return candidate;

	return current;
}

function mediaFileBaseName(sourceFileName: string): string {
	return sourceFileName.replace(FILE_EXTENSION_REGEX, "").replace(ILLEGAL_FILENAME_CHARS_REGEX, "_").slice(0, 120) || "download";
}

class DownloadsService {
	readonly serviceName = "DownloadsService";
	readonly logger = createLogger("DownloadsService");

	/** Kill-switches for in-flight ffmpeg runs, keyed by download id. */
	private readonly abortHandles = new Map<string, () => void>();
	private retentionTimerStarted = false;

	constructor() {
		this.scheduleRetentionSweep();
	}

	async prepare(profileId: string | undefined, mediaFileId: string, quality: string = DEFAULT_DOWNLOAD_QUALITY): Promise<DownloadJobView> {
		return await runSafely(this, "prepare", async () => {
			assertProfileId(profileId);
			if (!serverConfig.downloads.enabled)
				throw new DomainError("forbidden", "Downloads are disabled on this server", { code: "downloads.disabled" });

			if (!mediaFileId.trim()) throw new DomainError("validation", "mediaFileId is required", { code: "downloads.media_file_required" });

			const mediaFile = await mediaRepository.findByPrimaryId({
				primaryId: mediaFileId,
				fields: QueryFields.parse({ fields: "id,filePath,duration,fileName" }),
			});
			assertFound(mediaFile, "MediaFile", mediaFileId);
			if (quality !== "original" && !(mediaFile.duration && mediaFile.duration > 0)) {
				throw new DomainError("validation", "Transcoded download requires a known file duration", { code: "downloads.duration_unknown" });
			}

			if (await downloadsRepository.hasActiveByProfileAndMedia(profileId, mediaFileId)) {
				throw new DomainError("conflict", "This title is already downloading for this profile", { code: "downloads.in_progress" });
			}

			if ((await downloadsRepository.countPendingByProfile(profileId)) >= MAX_QUEUED_DOWNLOADS_PER_PROFILE) {
				throw new DomainError("conflict", "This profile already has too many downloads waiting", { code: "downloads.queue_full" });
			}

			const { maxBytes, usedBytes } = await this.getStorageQuota(profileId);
			if (maxBytes > 0 && usedBytes >= maxBytes) {
				throw new DomainError("conflict", "Storage quota exceeded — delete older downloads first", {
					code: "downloads.quota_exceeded",
					params: { maxBytes, usedBytes },
				});
			}

			const row = await downloadsRepository.insert({
				profileId,
				mediaFileId,
				quality: isDownloadQuality(quality) ? quality : DEFAULT_DOWNLOAD_QUALITY,
			});
			await this.promoteQueued(profileId);

			return await this.viewOf(row);
		});
	}

	/**
	 * Queues every episode of a season with its default media file (or its first one). A season whose estimated size
	 * does not fit the free storage is refused unless `force` is set. Each episode reports its own outcome.
	 */
	async queueSeason(
		profileId: string | undefined,
		body: { seasonId: string; quality?: string | undefined; force?: boolean | undefined },
		assertAccess: (mediaFileId: string) => Promise<void>,
	): Promise<{ results: BulkRefreshItem[] }> {
		return await runSafely(this, "queueSeason", async () => {
			assertProfileId(profileId);
			if (!serverConfig.downloads.enabled)
				throw new DomainError("forbidden", "Downloads are disabled on this server", { code: "downloads.disabled" });

			const season = await seasonsRepository.findByPrimaryId({
				primaryId: body.seasonId,
				fields: QueryFields.parse({ fields: "id,metadataId" }),
			});
			assertFound(season, "Season", body.seasonId);

			const episodeFiles = new Map<string, SeasonFileCandidate | null>();
			for (const row of await episodesRepository.findEpisodesWithFilesByMetadataId(season.metadataId)) {
				if (row.seasonId !== season.id) continue;
				const candidate = row.mediaFileId
					? { mediaFileId: row.mediaFileId, isDefault: row.mediaFileIsDefault === true, sizeBytes: row.mediaFileSize ?? 0 }
					: null;
				episodeFiles.set(row.id, preferDefaultFile(episodeFiles.get(row.id) ?? null, candidate));
			}

			const estimatedBytes = [...episodeFiles.values()].reduce((sum, chosen) => sum + (chosen?.sizeBytes ?? 0), 0);
			const { maxBytes, usedBytes } = await this.getStorageQuota(profileId);
			const freeBytes = Math.max(0, maxBytes - usedBytes);
			if (maxBytes > 0 && estimatedBytes > freeBytes && !body.force) {
				throw new DomainError("conflict", "This season is larger than the free download space", {
					code: "downloads.season_exceeds_quota",
					params: { estimatedBytes, freeBytes },
				});
			}

			const results: BulkRefreshItem[] = [];
			for (const [episodeId, chosen] of episodeFiles) {
				if (!chosen) {
					results.push({ id: episodeId, ok: false, code: "downloads.no_media_file" });
					continue;
				}

				try {
					await assertAccess(chosen.mediaFileId);
					await this.prepare(profileId, chosen.mediaFileId, body.quality);
					results.push({ id: episodeId, ok: true });
				} catch (error) {
					results.push({ id: episodeId, ok: false, code: errorCodeOf(error, "downloads.queue_failed") });
				}
			}

			return { results };
		});
	}

	async list(profileId: string): Promise<{ data: DownloadJobView[]; quota: { usedBytes: number; maxBytes: number } }> {
		const [rows, quota] = await Promise.all([downloadsRepository.findByProfile(profileId), this.getStorageQuota(profileId)]);

		const metadataIds = await this.metadataIdsOf(rows);

		return { data: rows.map((row) => this.toView(row, metadataIds.get(row.mediaFileId) ?? null)), quota };
	}

	/** One page of every profile's downloads for the admin overview, with the counts per status for its counters. */
	async listAllPage(query: { page?: number | undefined; limit?: number | undefined; status?: DownloadStatus | undefined }) {
		const pagination = QueryPagination.resolvePageParams(query, { defaultLimit: 50 });
		const [result, counts] = await Promise.all([
			downloadsRepository.findPage({ status: query.status, limit: pagination.limit, offset: pagination.offset }),
			downloadsRepository.countByStatus(),
		]);
		const metadataIds = await this.metadataIdsOf(result.data);

		return {
			...QueryPagination.createResponse({
				total: result.total,
				pagination,
				data: result.data.map((row) => ({
					...this.toView(row, metadataIds.get(row.mediaFileId) ?? null),
					profileId: row.profileId,
				})),
			}),
			counts,
		};
	}

	/** Ownership-checked variants — a profile only ever sees its own jobs. */
	async getJobViewForProfile(jobId: string, profileId: string): Promise<DownloadJobView | null> {
		const row = await this.getOwnedDownload(jobId, profileId);

		return row ? await this.viewOf(row) : null;
	}

	async cancelForProfile(jobId: string, profileId: string): Promise<{ success: true }> {
		await this.assertOwnedDownload(jobId, profileId);

		return this.cancel(jobId);
	}

	/** Media file of an owned download; the route checks stream access against it before a retry. */
	async mediaFileIdForProfile(jobId: string, profileId: string): Promise<string> {
		return (await this.assertOwnedDownload(jobId, profileId)).mediaFileId;
	}

	/** Starts a failed or cancelled download again with the same file and quality. The old row is replaced once the new one is queued. */
	async retryForProfile(jobId: string, profileId: string): Promise<DownloadJobView> {
		const row = await this.assertOwnedDownload(jobId, profileId);
		if (row.status !== "failed" && row.status !== "cancelled") {
			throw new DomainError("conflict", "Only failed or cancelled downloads can be retried", {
				code: "downloads.not_retryable",
				params: { status: row.status },
			});
		}

		const view = await this.prepare(profileId, row.mediaFileId, row.quality);
		await this.delete(jobId);

		return view;
	}

	async deleteForProfile(jobId: string, profileId: string): Promise<{ success: true }> {
		await this.assertOwnedDownload(jobId, profileId);

		return this.delete(jobId);
	}

	async resolveFileForProfile(jobId: string, profileId: string): Promise<{ fileName: string; blob: Blob } | null> {
		return await this.resolveFileFromRow(await this.getOwnedDownload(jobId, profileId));
	}

	async cancel(downloadId: string): Promise<{ success: true }> {
		const row = await this.requireDownload(downloadId);

		if (row.status === "completed")
			throw new DomainError("validation", "Completed download cannot be cancelled", { code: "completed_download_cancel" });

		this.killInFlight(downloadId);
		await downloadsRepository.update(downloadId, { status: "cancelled" });
		await this.deleteArtifactFile(row);

		return { success: true };
	}

	/** Idempotent by contract — deleting an already-removed job still succeeds,
	 * while cancel is a state transition and reports missing jobs as 404. */
	async delete(downloadId: string): Promise<{ success: true }> {
		const row = await downloadsRepository.findById(downloadId);
		if (row) {
			this.killInFlight(downloadId);
			await this.deleteArtifactFile(row);
			await downloadsRepository.delete(downloadId);
		}

		return { success: true };
	}

	/** Completed download as a file handle — never exposes the storage path. */
	async resolveFile(downloadId: string): Promise<{ fileName: string; blob: Blob } | null> {
		return await this.resolveFileFromRow(await downloadsRepository.findById(downloadId));
	}

	private async resolveFileFromRow(row: DownloadRow | null | undefined): Promise<{ fileName: string; blob: Blob } | null> {
		if (row?.status !== "completed" || !row.fileName) return null;

		const path = this.artifactPath(row.id, row.fileName);
		const handle = file(path);
		if (!(await handle.exists())) return null;

		return { fileName: row.fileName, blob: handle };
	}

	/**
	 * Boot reconciliation: a download interrupted by a crash/restart is stuck in
	 * `pending`/`processing` with no live ffmpeg, which blocks the profile's only
	 * active slot. Re-check the source, fail it when the file is gone, otherwise
	 * reset to `pending` and re-enqueue the processor (the worker dedupe key keeps
	 * this single-shot even when the job row was already recovered).
	 */
	async reconcileOnStartup(): Promise<number> {
		const stale = await downloadsRepository.findByStatuses(["pending", "processing"]);
		let requeued = 0;
		for (const row of stale) {
			const mediaFile = await mediaRepository.findByPrimaryId({
				primaryId: row.mediaFileId,
				fields: QueryFields.parse({ fields: "id,filePath" }),
			});
			if (!mediaFile?.filePath) {
				await downloadsRepository.update(row.id, { status: "failed", errorText: "download.media_missing" });
				continue;
			}

			await downloadsRepository.update(row.id, { status: "pending", errorText: null });
			await enqueueDownloadsProcess(row.id);
			requeued++;
		}

		return requeued;
	}

	/** Marks a download failed unless it already finished or was cancelled. */
	async markFailed(downloadId: string, errorCode: string): Promise<void> {
		const row = await downloadsRepository.findById(downloadId);
		if (!row || row.status === "completed" || row.status === "cancelled") return;

		this.killInFlight(downloadId);
		await downloadsRepository.update(downloadId, { status: "failed", errorText: errorCode });
		detach(this.promoteQueued(row.profileId));
	}

	private async requireDownload(downloadId: string): Promise<DownloadRow> {
		const row = await downloadsRepository.findById(downloadId);
		if (!row) throw new DomainError("not_found", "Download not found", { code: "download_not_found" });

		return row;
	}

	private killInFlight(downloadId: string): void {
		this.abortHandles.get(downloadId)?.();
	}

	/**
	 * Enqueues the profile's oldest waiting downloads, as many as it has free running slots. The worker claims a slot
	 * when it runs, so a download that is enqueued twice is harmless. Never rejects: a failure is only logged.
	 */
	private async promoteQueued(profileId: string): Promise<void> {
		try {
			const freeSlots = serverConfig.downloads.maxConcurrentPerProfile - (await downloadsRepository.countProcessingByProfile(profileId));
			if (freeSlots <= 0) return;

			for (const row of await downloadsRepository.findPendingByProfile(profileId, freeSlots)) {
				await enqueueDownloadsProcess(row.id);
			}
		} catch (error) {
			this.logger.warn("Could not start the queued downloads", { profileId, error: errorMessage(error) });
		}
	}

	private async getStorageQuota(profileId: string): Promise<{ maxBytes: number; usedBytes: number }> {
		return {
			maxBytes: serverConfig.downloads.maxStorageBytesPerProfile,
			usedBytes: await downloadsRepository.storageUsedByProfile(profileId),
		};
	}

	/** Media file id → title id for the rows' media files, in one batched lookup. */
	private async metadataIdsOf(rows: readonly DownloadRow[]): Promise<Map<string, string>> {
		const identities = await mediaRepository.findIdentitiesByIds([...new Set(rows.map((row) => row.mediaFileId))]);

		return new Map(identities.map((identity): [string, string] => [identity.id, identity.metadataId]));
	}

	/** The view of one row, with the title its media file belongs to. */
	private async viewOf(row: DownloadRow): Promise<DownloadJobView> {
		const [identity] = await mediaRepository.findIdentitiesByIds([row.mediaFileId]);

		return this.toView(row, identity?.metadataId ?? null);
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
		const row = await this.getOwnedDownload(jobId, profileId);
		if (!row) throw new DomainError("not_found", "Download not found", { code: "download_not_found" });

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

		// Only a free running slot starts the download; otherwise it waits and is started when a slot frees up.
		if (!(await downloadsRepository.claimForProcessing(downloadId, row.profileId, serverConfig.downloads.maxConcurrentPerProfile))) return;

		const outputPath = await this.resolveOutputPath(downloadId, row.quality, context.sourceFileName);

		try {
			const exitCode = await this.runFfmpeg({ downloadId, filePath, durationSeconds, quality: row.quality, outputPath, options });
			await this.finalizeDownload({ downloadId, profileId: row.profileId, quality: row.quality, outputPath, exitCode });
		} finally {
			this.abortHandles.delete(downloadId);
			detach(this.promoteQueued(row.profileId));
		}
	}

	private async loadPendingDownload(downloadId: string): Promise<{
		row: DownloadRow;
		filePath: string;
		durationSeconds: number;
		sourceFileName: string;
	} | null> {
		const row = await downloadsRepository.findById(downloadId);
		if (!row) throw new DomainError("not_found", `Download not found: ${downloadId}`, { code: "download_not_found" });

		if (row.status !== "pending") return null;

		const mediaFile = await mediaRepository.findByPrimaryId({
			primaryId: row.mediaFileId,
			fields: QueryFields.parse({ fields: "id,filePath,duration,fileName" }),
		});
		if (!mediaFile?.filePath) {
			// Retrying cannot bring the file back, and leaving the row `pending`
			// pinned the profile's single active-download slot forever.
			await downloadsRepository.update(downloadId, { status: "failed", errorText: "download.media_missing" });

			return null;
		}

		return { row, filePath: mediaFile.filePath, durationSeconds: mediaFile.duration ?? 0, sourceFileName: mediaFile.fileName };
	}

	private async resolveOutputPath(downloadId: string, quality: string, sourceFileName: string): Promise<string> {
		const baseName = mediaFileBaseName(sourceFileName);
		const fileName = `${baseName}.${quality === "original" ? "mp4" : `${quality}.mp4`}`;
		const outputDir = PathUtils.join(serverConfig.paths.downloads, downloadId);
		await DirUtils.create(outputDir);
		const outputPath = PathUtils.join(outputDir, fileName);
		await downloadsRepository.update(downloadId, { fileName });

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
					errorText: "download.source_not_mp4",
				});
			} else {
				await downloadsRepository.update(downloadId, { status: "failed", errorText: "download.ffmpeg_failed" });
			}

			return;
		}

		const output = file(outputPath);
		const sizeBytes = output.size;
		if (sizeBytes === 0) {
			await this.deleteArtifact(outputPath);
			await downloadsRepository.update(downloadId, { status: "failed", errorText: "download.empty_output" });

			return;
		}

		const { maxBytes, usedBytes } = await this.getStorageQuota(profileId);
		if (maxBytes > 0 && usedBytes + sizeBytes > maxBytes) {
			await this.deleteArtifact(outputPath);
			await downloadsRepository.update(downloadId, {
				status: "failed",
				errorText: "download.storage_limit",
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

	/**
	 * Removes artifact directories whose download row is gone. A row is written before
	 * its directory exists, so a directory without a row belongs to a row deleted
	 * without its file, typically after a crash between the two steps.
	 */
	async sweepOrphanArtifacts(): Promise<{ removed: number }> {
		const root = serverConfig.paths.downloads;
		let candidates: string[];
		try {
			const entries = await readdir(root, { withFileTypes: true });
			candidates = entries
				.filter((entry) => entry.isDirectory() && DOWNLOAD_ID_DIRECTORY_REGEX.test(entry.name))
				.map((entry) => entry.name);
		} catch (error) {
			if (isMissingFile(error)) return { removed: 0 };

			throw error;
		}

		let removed = 0;
		for (let offset = 0; offset < candidates.length; offset += ORPHAN_SWEEP_BATCH_SIZE) {
			const batch = candidates.slice(offset, offset + ORPHAN_SWEEP_BATCH_SIZE);
			const known = await downloadsRepository.findExistingIds(batch);
			for (const id of batch) {
				if (known.has(id)) continue;

				try {
					await rm(PathUtils.join(root, id), { recursive: true, force: true });
					removed++;
				} catch (error) {
					this.logger.warn("Could not remove the artifacts of a deleted download", { downloadId: id, error: errorMessage(error) });
				}
			}
		}

		if (removed > 0) this.logger.info("Removed artifacts of deleted downloads", { removed });

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
						await this.sweepOrphanArtifacts();
					} catch (error) {
						this.logger.warn("Retention sweep failed", { error });
					}
				})(),
			);
		};
		setTimeout(sweep, RETENTION_SWEEP_FIRST_DELAY_MS).unref();
		setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS).unref();
	}

	private toView(row: DownloadRow, metadataId: string | null): DownloadJobView {
		return {
			id: row.id,
			mediaFileId: row.mediaFileId,
			metadataId,
			quality: row.quality,
			status: row.status,
			progressPercent: row.progressPercent,
			sizeBytes: row.sizeBytes,
			fileName: row.fileName,
			downloadUrl: row.status === "completed" ? `/v1/downloads/${row.id}/file` : null,
			errorCode: toErrorCode(row.errorText, "download.failed"),
			createdAt: row.createdAt.toISOString(),
			updatedAt: row.updatedAt.toISOString(),
		};
	}
}

export const downloadsService = new DownloadsService();
