import { downloadsProcess, downloadsStorage } from "@/modules/downloads/downloads.ports";
import { DomainError } from "@/utils/domain.errors";
import { detach } from "@/utils/promise.utils";
import { deleteArtifactFile } from "./artifacts/artifacts.service";
import { type PrepareOne, promoteQueued } from "./queue.service";
import type { DownloadsServiceState, WithoutState } from "./shared.utils";
import { failMissingSource } from "./shared.utils";
import { assertOwnedDownload, requireDownload } from "./views/rows.utils";
import type { DownloadJobView } from "./views/views.mapper";

type CancelOne = (...args: WithoutState<typeof cancel>) => ReturnType<typeof cancel>;
type DeleteOne = (...args: WithoutState<typeof deleteOne>) => ReturnType<typeof deleteOne>;

/** Ends the ffmpeg run of a download, if this process is running one. */
function killInFlight(state: DownloadsServiceState, downloadId: string): void {
	state.abortHandles.get(downloadId)?.();
}

export async function cancel(state: DownloadsServiceState, downloadId: string): Promise<{ success: true }> {
	const row = await requireDownload(downloadId);

	if (row.status === "completed")
		throw new DomainError("validation", "Completed download cannot be cancelled", { code: "completed_download_cancel" });

	killInFlight(state, downloadId);
	await downloadsStorage().update(downloadId, { status: "cancelled" });
	await deleteArtifactFile(row);

	return { success: true };
}

/** Idempotent by contract — deleting an already-removed job still succeeds,
 * while cancel is a state transition and reports missing jobs as 404. */
export async function deleteOne(state: DownloadsServiceState, downloadId: string): Promise<{ success: true }> {
	const row = await downloadsStorage().findById(downloadId);
	if (row) {
		killInFlight(state, downloadId);
		await deleteArtifactFile(row);
		await downloadsStorage().delete(downloadId);
	}

	return { success: true };
}

export async function cancelForProfile(jobId: string, profileId: string, cancelOne: CancelOne): Promise<{ success: true }> {
	await assertOwnedDownload(jobId, profileId);

	return await cancelOne(jobId);
}

export async function deleteForProfile(jobId: string, profileId: string, deleteOneOf: DeleteOne): Promise<{ success: true }> {
	await assertOwnedDownload(jobId, profileId);

	return await deleteOneOf(jobId);
}

/** Starts a failed or cancelled download again with the same file and quality. The old row is replaced once the new one is queued. */
export async function retryForProfile(
	jobId: string,
	profileId: string,
	prepareOne: PrepareOne,
	deleteOneOf: DeleteOne,
): Promise<DownloadJobView> {
	const row = await assertOwnedDownload(jobId, profileId);
	if (row.status !== "failed" && row.status !== "cancelled") {
		throw new DomainError("conflict", "Only failed or cancelled downloads can be retried", {
			code: "downloads.not_retryable",
			params: { status: row.status },
		});
	}

	const view = await prepareOne(profileId, row.mediaFileId, row.quality);
	await deleteOneOf(jobId);

	return view;
}

/**
 * Boot reconciliation: a download interrupted by a crash/restart is stuck in
 * `pending`/`processing` with no live ffmpeg, which blocks the profile's only
 * active slot. Re-check the source, fail it when the file is gone, otherwise
 * reset to `pending` and re-enqueue the processor (the worker dedupe key keeps
 * this single-shot even when the job row was already recovered).
 */
export async function reconcileOnStartup(): Promise<number> {
	const stale = await downloadsStorage().findByStatuses(["pending", "processing"]);
	let requeued = 0;
	for (const row of stale) {
		const mediaFile = await downloadsStorage().findMediaFileForDownload(row.mediaFileId);
		if (!mediaFile?.filePath) {
			await failMissingSource(row.id);
			continue;
		}

		await downloadsStorage().update(row.id, { status: "pending", errorText: null });
		await downloadsProcess().enqueueProcess(row.id);
		requeued++;
	}

	return requeued;
}

/** Marks a download failed unless it already finished or was cancelled. */
export async function markFailed(state: DownloadsServiceState, downloadId: string, errorCode: string): Promise<void> {
	const row = await downloadsStorage().findById(downloadId);
	if (!row || row.status === "completed" || row.status === "cancelled") return;

	killInFlight(state, downloadId);
	await downloadsStorage().update(downloadId, { status: "failed", errorText: errorCode });
	detach(promoteQueued(state, row.profileId));
}
