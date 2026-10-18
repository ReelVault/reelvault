import type { BulkRefreshItem } from "@reelvault/sdk/common";
import { createLogger } from "@/utils/logger.utils";
import { detach } from "@/utils/promise.utils";
import {
	cancel,
	cancelForProfile,
	deleteForProfile,
	deleteOne,
	markFailed,
	reconcileOnStartup,
	retryForProfile,
} from "./lifecycle.service";
import { prepare, queueSeason } from "./queue.service";
import { type RetentionTimers, startRetentionTimers, stopRetentionTimers, sweepExpired, sweepOrphanArtifacts } from "./retention.service";
import { runDownload } from "./runners/process.runner";
import type { DownloadRunOptions, DownloadsServiceState } from "./shared.utils";
import {
	type DownloadsPageQuery,
	getJobViewForProfile,
	list,
	listAllPage,
	mediaFileIdForProfile,
	resolveFile,
	resolveFileForProfile,
} from "./views/queries.reader";
import type { DownloadJobView } from "./views/views.mapper";

class DownloadsService {
	readonly serviceName = "DownloadsService";
	readonly logger = createLogger("DownloadsService");

	private readonly state: DownloadsServiceState = {
		serviceName: this.serviceName,
		logger: this.logger,
		abortHandles: new Map(),
	};

	private retentionTimers: RetentionTimers | undefined;

	constructor() {
		this.retentionTimers = startRetentionTimers(() => detach(this.sweepRetention()));
	}

	async prepare(profileId: string | undefined, mediaFileId: string, quality?: string): Promise<DownloadJobView> {
		return await prepare(this.state, profileId, mediaFileId, quality);
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
		return await queueSeason(this.state, profileId, body, assertAccess, (...args) => this.prepare(...args));
	}

	async list(profileId: string): Promise<{ data: DownloadJobView[]; quota: { usedBytes: number; maxBytes: number } }> {
		return await list(profileId);
	}

	/** One page of every profile's downloads for the admin overview, with the counts per status for its counters. */
	async listAllPage(query: DownloadsPageQuery) {
		return await listAllPage(query);
	}

	/** Ownership-checked variants — a profile only ever sees its own jobs. */
	async getJobViewForProfile(jobId: string, profileId: string): Promise<DownloadJobView | null> {
		return await getJobViewForProfile(jobId, profileId);
	}

	async cancelForProfile(jobId: string, profileId: string): Promise<{ success: true }> {
		return await cancelForProfile(jobId, profileId, (...args) => this.cancel(...args));
	}

	/** Media file of an owned download; the route checks stream access against it before a retry. */
	async mediaFileIdForProfile(jobId: string, profileId: string): Promise<string> {
		return await mediaFileIdForProfile(jobId, profileId);
	}

	/** Starts a failed or cancelled download again with the same file and quality. The old row is replaced once the new one is queued. */
	async retryForProfile(jobId: string, profileId: string): Promise<DownloadJobView> {
		return await retryForProfile(
			jobId,
			profileId,
			(...args) => this.prepare(...args),
			(...args) => this.delete(...args),
		);
	}

	async deleteForProfile(jobId: string, profileId: string): Promise<{ success: true }> {
		return await deleteForProfile(jobId, profileId, (...args) => this.delete(...args));
	}

	async resolveFileForProfile(jobId: string, profileId: string): Promise<{ fileName: string; blob: Blob } | null> {
		return await resolveFileForProfile(jobId, profileId);
	}

	async cancel(downloadId: string): Promise<{ success: true }> {
		return await cancel(this.state, downloadId);
	}

	/** Idempotent by contract — deleting an already-removed job still succeeds,
	 * while cancel is a state transition and reports missing jobs as 404. */
	async delete(downloadId: string): Promise<{ success: true }> {
		return await deleteOne(this.state, downloadId);
	}

	/** Completed download as a file handle — never exposes the storage path. */
	async resolveFile(downloadId: string): Promise<{ fileName: string; blob: Blob } | null> {
		return await resolveFile(downloadId);
	}

	/**
	 * Boot reconciliation: a download interrupted by a crash/restart is stuck in
	 * `pending`/`processing` with no live ffmpeg, which blocks the profile's only
	 * active slot. Re-check the source, fail it when the file is gone, otherwise
	 * reset to `pending` and re-enqueue the processor.
	 */
	async reconcileOnStartup(): Promise<number> {
		return await reconcileOnStartup();
	}

	/** Marks a download failed unless it already finished or was cancelled. */
	async markFailed(downloadId: string, errorCode: string): Promise<void> {
		return await markFailed(this.state, downloadId, errorCode);
	}

	/**
	 * Runs one download job inside the worker: pending → processing → ffmpeg MP4
	 * (faststart) → completed. A `cancelled` row written mid-run makes the exit
	 * handler drop the partial file instead of marking completion.
	 */
	async process(downloadId: string, options: DownloadRunOptions = {}): Promise<void> {
		return await runDownload(this.state, downloadId, options);
	}

	/** Deletes completed/failed/cancelled downloads older than the retention window. */
	async sweepExpired(): Promise<{ removed: number }> {
		return await sweepExpired(this.state);
	}

	/**
	 * Removes artifact directories whose download row is gone. A row is written before
	 * its directory exists, so a directory without a row belongs to a row deleted
	 * without its file, typically after a crash between the two steps.
	 */
	async sweepOrphanArtifacts(): Promise<{ removed: number }> {
		return await sweepOrphanArtifacts(this.state);
	}

	/** Stops the retention sweeps so none of them touches the database after shutdown has closed it. */
	shutdown(): void {
		if (this.retentionTimers) stopRetentionTimers(this.retentionTimers);
		this.retentionTimers = undefined;
	}

	private async sweepRetention(): Promise<void> {
		try {
			await this.sweepExpired();
			await this.sweepOrphanArtifacts();
		} catch (error) {
			this.logger.warn("Retention sweep failed", { error });
		}
	}
}

export const downloadsService = new DownloadsService();
