import { join } from "node:path";
import type { BulkRefreshItem } from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";
import type { DownloadStatus } from "@/integrations/drizzle-orm/constants/downloads.constants";
import { createPageResponse, resolvePageParams } from "@/integrations/drizzle-orm/query/pagination.utils";
import { parseFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { type DownloadRow, downloadsRepository } from "@/repositories/downloads.repository";
import { episodesRepository } from "@/repositories/episodes.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import { seasonsRepository } from "@/repositories/seasons.repository";
import { toMap } from "@/utils/array.utils";
import { type DirectoryEntry, readDirectoryEntries, removeTree } from "@/utils/directory.utils";
import { assertFound, assertProfileId, DomainError, errorCodeOf, errorMessage, isMissingFile } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { detach } from "@/utils/promise.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { enqueueDownloadsProcess } from "@/workers/definitions/downloads/downloads-process.worker";
import {
	type DownloadRunContext,
	type DownloadRunOptions,
	failMissingSource,
	findDownloadSource,
	loadPendingDownload,
	runClaimedDownload,
} from "./download.runner";
import { deleteDownloadFile, resolveDownloadFile } from "./download-files.utils";
import { DEFAULT_DOWNLOAD_QUALITY, isDownloadQuality } from "./download-quality.utils";
import { type DownloadJobView, toDownloadView } from "./download-view.mapper";

/** Most downloads one profile may have waiting for a running slot; a request beyond it is refused. */
const MAX_QUEUED_DOWNLOADS_PER_PROFILE = 200;
/** Retention sweep cadence — first pass shortly after boot, then daily. */
const RETENTION_SWEEP_FIRST_DELAY_MS = 60_000;
const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Expired rows are fetched in pages of this size; a shorter page is the last one. */
const EXPIRED_SWEEP_PAGE_SIZE = 500;
/** Artifact directories are named after their download id, a UUID; anything else under the root is left alone. */
const DOWNLOAD_ID_DIRECTORY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORPHAN_SWEEP_BATCH_SIZE = 500;

export interface DownloadsPageQuery {
	page?: number | undefined;
	limit?: number | undefined;
	status?: DownloadStatus | undefined;
}

interface SeasonFileCandidate {
	mediaFileId: string;
	isDefault: boolean;
	sizeBytes: number;
}

interface StorageQuota {
	maxBytes: number;
	usedBytes: number;
}

/** The default file of an episode wins; otherwise the first file seen is kept. */
function preferDefaultFile(current: SeasonFileCandidate | null, candidate: SeasonFileCandidate | null): SeasonFileCandidate | null {
	if (!current) return candidate;
	if (candidate?.isDefault && !current.isDefault) return candidate;

	return current;
}

/** Refuses the call before any work: downloads must be enabled and the caller must have a profile. */
function assertDownloadsAvailable(profileId: string | undefined): asserts profileId is string {
	assertProfileId(profileId);
	if (!serverConfig.downloads.enabled)
		throw new DomainError("forbidden", "Downloads are disabled on this server", { code: "downloads.disabled" });
}

function downloadNotFound(): DomainError {
	return new DomainError("not_found", "Download not found", { code: "download_not_found" });
}

function completedDownloadCancel(): DomainError {
	return new DomainError("validation", "Completed download cannot be cancelled", { code: "completed_download_cancel" });
}

async function getStorageQuota(profileId: string): Promise<StorageQuota> {
	return {
		maxBytes: serverConfig.downloads.maxStorageBytesPerProfile,
		usedBytes: await downloadsRepository.storageUsedByProfile(profileId),
	};
}

/** The download when it belongs to the profile; another profile's id reads as absent, so ids leak nothing. */
async function findOwnedDownload(jobId: string, profileId: string): Promise<DownloadRow | null> {
	const row = await downloadsRepository.findById(jobId);
	if (!row || row.profileId !== profileId) return null;

	return row;
}

async function requireOwnedDownload(jobId: string, profileId: string): Promise<DownloadRow> {
	const row = await findOwnedDownload(jobId, profileId);
	if (!row) throw downloadNotFound();

	return row;
}

/** Media file id → title id for the rows' media files, in one batched lookup. */
async function metadataIdsOf(rows: readonly DownloadRow[]): Promise<Map<string, string>> {
	const identities = await mediaRepository.findIdentitiesByIds([...new Set(rows.map((row) => row.mediaFileId))]);

	return toMap(
		identities,
		(identity) => identity.id,
		(identity) => identity.metadataId,
	);
}

async function toViews(rows: readonly DownloadRow[]): Promise<DownloadJobView[]> {
	const metadataIds = await metadataIdsOf(rows);

	return rows.map((row) => toDownloadView(row, metadataIds.get(row.mediaFileId) ?? null));
}

async function toView(row: DownloadRow): Promise<DownloadJobView> {
	const metadataIds = await metadataIdsOf([row]);

	return toDownloadView(row, metadataIds.get(row.mediaFileId) ?? null);
}

/** The preferred media file per episode of the season. */
async function collectSeasonFiles(season: { id: string; metadataId: string }): Promise<Map<string, SeasonFileCandidate | null>> {
	const episodeFiles = new Map<string, SeasonFileCandidate | null>();
	for (const row of await episodesRepository.findEpisodesWithFilesByMetadataId(season.metadataId)) {
		if (row.seasonId !== season.id) continue;
		const candidate = row.mediaFileId
			? { mediaFileId: row.mediaFileId, isDefault: row.mediaFileIsDefault === true, sizeBytes: row.mediaFileSize ?? 0 }
			: null;
		episodeFiles.set(row.id, preferDefaultFile(episodeFiles.get(row.id) ?? null, candidate));
	}

	return episodeFiles;
}

/**
 * Offline downloads: a profile queues a media file at a quality, the worker transcodes
 * it into an MP4 under `paths.downloads`, and the profile fetches the file. Each profile
 * runs at most `maxConcurrentPerProfile` downloads at once; the rest wait as `pending`.
 */
class DownloadsService {
	readonly serviceName = "DownloadsService";
	readonly logger = createLogger("DownloadsService");

	private readonly runContext: DownloadRunContext = { logger: this.logger, abortHandles: new Map() };
	private retentionTimers: { first: Timer; interval: Timer } | undefined;

	constructor() {
		const sweep = () => detach(this.sweepRetention());
		const first = setTimeout(sweep, RETENTION_SWEEP_FIRST_DELAY_MS);
		const interval = setInterval(sweep, RETENTION_SWEEP_INTERVAL_MS);
		first.unref();
		interval.unref();
		this.retentionTimers = { first, interval };
	}

	async prepare(profileId: string | undefined, mediaFileId: string, quality: string = DEFAULT_DOWNLOAD_QUALITY): Promise<DownloadJobView> {
		return await runSafely(this, "prepare", async () => {
			assertDownloadsAvailable(profileId);

			if (!mediaFileId.trim()) throw new DomainError("validation", "mediaFileId is required", { code: "downloads.media_file_required" });

			const mediaFile = await findDownloadSource(mediaFileId);
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

			const { maxBytes, usedBytes } = await getStorageQuota(profileId);
			if (maxBytes > 0 && usedBytes >= maxBytes) {
				throw new DomainError("conflict", "Storage quota exceeded — delete older downloads first", {
					code: "downloads.quota_exceeded",
					params: { maxBytes, usedBytes },
				});
			}

			// awaits: sequential — the queued row must exist before the queue is promoted
			const row = await downloadsRepository.insert({
				profileId,
				mediaFileId,
				quality: isDownloadQuality(quality) ? quality : DEFAULT_DOWNLOAD_QUALITY,
			});
			await this.promoteQueued(profileId);

			return await toView(row);
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
			assertDownloadsAvailable(profileId);

			const season = await seasonsRepository.findByPrimaryId({
				primaryId: body.seasonId,
				fields: parseFields({ fields: "id,metadataId" }),
			});
			assertFound(season, "Season", body.seasonId);

			const episodeFiles = await collectSeasonFiles(season);

			let estimatedBytes = 0;
			for (const chosen of episodeFiles.values()) estimatedBytes += chosen?.sizeBytes ?? 0;
			const { maxBytes, usedBytes } = await getStorageQuota(profileId);
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
					// awaits: sequential — access is checked before the download is prepared
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

	async list(profileId: string): Promise<{ data: DownloadJobView[]; quota: StorageQuota }> {
		const [rows, quota] = await Promise.all([downloadsRepository.findByProfile(profileId), getStorageQuota(profileId)]);

		return { data: await toViews(rows), quota };
	}

	/** One page of every profile's downloads for the admin overview, with the counts per status for its counters. */
	async listAllPage(query: DownloadsPageQuery) {
		const pagination = resolvePageParams(query, { defaultLimit: 50 });
		const [result, counts] = await Promise.all([
			downloadsRepository.findPage({ status: query.status, limit: pagination.limit, offset: pagination.offset }),
			downloadsRepository.countByStatus(),
		]);
		const metadataIds = await metadataIdsOf(result.data);

		return {
			...createPageResponse({
				total: result.total,
				pagination,
				data: result.data.map((row) => ({ ...toDownloadView(row, metadataIds.get(row.mediaFileId) ?? null), profileId: row.profileId })),
			}),
			counts,
		};
	}

	/** Ownership-checked variants — a profile only ever sees its own jobs. */
	async getJobViewForProfile(jobId: string, profileId: string): Promise<DownloadJobView | null> {
		const row = await findOwnedDownload(jobId, profileId);
		if (!row) return null;

		return await toView(row);
	}

	/** Media file of an owned download; the route checks stream access against it before a retry. */
	async mediaFileIdForProfile(jobId: string, profileId: string): Promise<string> {
		return (await requireOwnedDownload(jobId, profileId)).mediaFileId;
	}

	async resolveFileForProfile(jobId: string, profileId: string): Promise<{ fileName: string; blob: Blob } | null> {
		return await resolveDownloadFile(await findOwnedDownload(jobId, profileId));
	}

	async cancelForProfile(jobId: string, profileId: string): Promise<{ success: true }> {
		await requireOwnedDownload(jobId, profileId);

		return await this.cancel(jobId);
	}

	async deleteForProfile(jobId: string, profileId: string): Promise<{ success: true }> {
		await requireOwnedDownload(jobId, profileId);

		return await this.delete(jobId);
	}

	/** Starts a failed or cancelled download again with the same file and quality. The old row is replaced once the new one is queued. */
	async retryForProfile(jobId: string, profileId: string): Promise<DownloadJobView> {
		const row = await requireOwnedDownload(jobId, profileId);
		if (row.status !== "failed" && row.status !== "cancelled") {
			throw new DomainError("conflict", "Only failed or cancelled downloads can be retried", {
				code: "downloads.not_retryable",
				params: { status: row.status },
			});
		}

		// awaits: sequential — the replacement is prepared before the old job is deleted
		const view = await this.prepare(profileId, row.mediaFileId, row.quality);
		await this.delete(jobId);

		return view;
	}

	async cancel(downloadId: string): Promise<{ success: true }> {
		const row = await downloadsRepository.findById(downloadId);
		if (!row) throw downloadNotFound();
		if (row.status === "completed") throw completedDownloadCancel();

		const cancelled = await downloadsRepository.cancelIfNotCompleted(downloadId);
		if (!cancelled) {
			const current = await downloadsRepository.findById(downloadId);
			if (!current) throw downloadNotFound();

			throw completedDownloadCancel();
		}

		this.killInFlight(downloadId);
		await deleteDownloadFile(cancelled);

		return { success: true };
	}

	/** Idempotent by contract — deleting an already-removed job still succeeds, while cancel is a state transition and reports missing jobs as 404. */
	async delete(downloadId: string): Promise<{ success: true }> {
		const row = await downloadsRepository.findById(downloadId);
		if (row) {
			this.killInFlight(downloadId);
			// awaits: sequential — the file is removed before its row, so a failed removal keeps the row to retry
			await deleteDownloadFile(row);
			await downloadsRepository.delete(downloadId);
		}

		return { success: true };
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
			const mediaFile = await findDownloadSource(row.mediaFileId);
			if (!mediaFile?.filePath) {
				await failMissingSource(row.id);
				continue;
			}

			if (!(await downloadsRepository.requeueIfActive(row.id))) continue;

			await enqueueDownloadsProcess(row.id);
			requeued++;
		}

		return requeued;
	}

	/** Marks a download failed unless it already finished or was cancelled. */
	async markFailed(downloadId: string, errorCode: string): Promise<void> {
		const row = await downloadsRepository.findById(downloadId);
		if (!row) return;
		if (!(await downloadsRepository.failIfActive(downloadId, errorCode))) return;

		this.killInFlight(downloadId);
		detach(this.promoteQueued(row.profileId));
	}

	/**
	 * Runs one download job inside the worker: pending → processing → ffmpeg MP4
	 * (faststart) → completed. Only a free running slot starts it; otherwise it waits
	 * and is started when a slot frees up.
	 */
	async process(downloadId: string, options: DownloadRunOptions = {}): Promise<void> {
		const pending = await loadPendingDownload(downloadId);
		if (!pending) return;

		const { profileId } = pending.row;
		if (!(await downloadsRepository.claimForProcessing(downloadId, profileId, serverConfig.downloads.maxConcurrentPerProfile))) return;

		try {
			await runClaimedDownload(this.runContext, pending, options);
		} finally {
			detach(this.promoteQueued(profileId));
		}
	}

	/** Deletes completed/failed/cancelled downloads older than the retention window. */
	async sweepExpired(): Promise<{ removed: number }> {
		const retentionDays = serverConfig.downloads.retentionDays;
		if (retentionDays <= 0) return { removed: 0 };

		let removed = 0;
		// Loop until a short page comes back — retention may span thousands of rows.
		for (;;) {
			const expired = await downloadsRepository.findExpired(retentionDays, EXPIRED_SWEEP_PAGE_SIZE);
			if (expired.length === 0) break;

			let progressed = false;
			for (const row of expired) {
				// One EBUSY/EACCES must not abort the whole sweep.
				try {
					// awaits: sequential — the file is removed before its row, so a failed removal keeps the row to retry
					await deleteDownloadFile(row);
					await downloadsRepository.delete(row.id);
					removed++;
					progressed = true;
				} catch (error) {
					this.logger.warn("Retention sweep failed for a download", { downloadId: row.id, error: errorMessage(error) });
				}
			}

			// No row could be removed → stop instead of re-fetching the same page forever.
			if (!progressed || expired.length < EXPIRED_SWEEP_PAGE_SIZE) break;
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
		let entries: DirectoryEntry[];
		try {
			entries = await readDirectoryEntries(root);
		} catch (error) {
			if (isMissingFile(error)) return { removed: 0 };

			throw error;
		}
		const candidates = entries
			.filter((entry) => entry.isDirectory && DOWNLOAD_ID_DIRECTORY_REGEX.test(entry.name))
			.map((entry) => entry.name);

		let removed = 0;
		for (let offset = 0; offset < candidates.length; offset += ORPHAN_SWEEP_BATCH_SIZE) {
			const batch = candidates.slice(offset, offset + ORPHAN_SWEEP_BATCH_SIZE);
			const known = await downloadsRepository.findExistingIds(batch);
			for (const id of batch) {
				if (known.has(id)) continue;

				try {
					await removeTree(join(root, id));
					removed++;
				} catch (error) {
					this.logger.warn("Could not remove the artifacts of a deleted download", { downloadId: id, error: errorMessage(error) });
				}
			}
		}

		if (removed > 0) this.logger.info("Removed artifacts of deleted downloads", { removed });

		return { removed };
	}

	/** Stops the retention sweeps so none of them touches the database after shutdown has closed it. */
	shutdown(): void {
		if (!this.retentionTimers) return;

		clearTimeout(this.retentionTimers.first);
		clearInterval(this.retentionTimers.interval);
		this.retentionTimers = undefined;
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

	/** Ends the ffmpeg run of a download, if this process is running one. */
	private killInFlight(downloadId: string): void {
		this.runContext.abortHandles.get(downloadId)?.();
	}

	private async sweepRetention(): Promise<void> {
		try {
			// awaits: sequential — orphan artifacts are found only after expired downloads are removed
			await this.sweepExpired();
			await this.sweepOrphanArtifacts();
		} catch (error) {
			this.logger.warn("Retention sweep failed", { error });
		}
	}
}

export const downloadsService = new DownloadsService();
