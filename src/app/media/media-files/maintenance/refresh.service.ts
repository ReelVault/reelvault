import type { BulkRefreshItem, FieldsQuery, MediaFileWithRelation, SelectFields, UpdateMediaFile } from "@reelvault/sdk/common";
import { auditBeforeFields, auditedUpdate, recordAuditSafe } from "@/app/admin/admin-audit.service";
import { runBulkItem } from "@/app/catalog/catalog.utils";
import { mediaFileRefreshService } from "@/app/media/media-files/refresh-media-file.operation";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { mediaRepository } from "@/app/repositories/media-files.repository";
import { assertFound } from "@/utils/domain.errors";
import { CATALOG_LIST_PATH_PREFIXES, invalidateResponseBodiesForPathPrefixes } from "@/utils/response-body.cache";
import { runSafely } from "@/utils/safe-execute.utils";
import { enqueueAllMediaFilesRefresh } from "@/workers/definitions/media/media-files-refresh-all.worker";
import { enqueueDeduped } from "@/workers/utils/enqueue-deduped.utils";
import type { MediaServiceState, WithoutState } from "../shared.utils";

export async function update<F extends string>(
	state: MediaServiceState,
	mediaFileId: string,
	body: UpdateMediaFile,
	query?: FieldsQuery<F>,
	context?: AdminAuditContext,
): Promise<SelectFields<MediaFileWithRelation, F>> {
	return await runSafely(state, "update", async () => {
		const result = await auditedUpdate({
			logger: state.logger,
			resourceType: "media_file",
			resourceId: mediaFileId,
			entityName: "MediaFile",
			before: () => mediaRepository.findByIdForRead(mediaFileId, auditBeforeFields(body, query)),
			update: () => mediaRepository.updateAndRead(mediaFileId, body, query),
			context,
		});

		invalidateResponseBodiesForPathPrefixes(CATALOG_LIST_PATH_PREFIXES);

		return result;
	});
}

export async function refresh(state: MediaServiceState, mediaFileId: string, context?: AdminAuditContext) {
	return await runSafely(state, "refresh", async () => {
		const mediaFile = await mediaRepository.findIdentity(mediaFileId);
		assertFound(mediaFile, "MediaFile", mediaFileId);

		const enqueued = await enqueueDeduped({
			// Only the technical refresh gates the whole request: a metadata refresh
			// already running must not swallow the probe/marker refresh — `queue`
			// reuses the active metadata task and still schedules the technical one.
			targets: [{ workerId: "media-file-technical-refresh", dedupeKey: mediaFileId }],
			type: "media-file-refresh",
			reference: { type: "media-file", id: mediaFileId },
			label: "media file refresh",
			enqueue: async (operationId) => {
				const queued = await mediaFileRefreshService.queue(mediaFileId, { operationId }, mediaFile.metadataId);

				return { operationId: queued.technicalTask.operationId };
			},
		});

		recordAuditSafe(
			{
				action: "update",
				resourceType: "media_file_refresh",
				resourceId: mediaFileId,
				after: { operationId: enqueued.operationId },
				context,
			},
			state.logger,
		);

		return enqueued;
	});
}

/** Queues a technical refresh for each listed media file; a file that cannot be queued reports its own code. */
export async function refreshMany(
	state: MediaServiceState,
	mediaFileIds: string[],
	context: AdminAuditContext | undefined,
	refreshOne: (...args: WithoutState<typeof refresh>) => ReturnType<typeof refresh>,
) {
	return await runSafely(state, "refreshMany", async () => {
		const results: BulkRefreshItem[] = [];
		for (const mediaFileId of new Set(mediaFileIds)) {
			results.push(await runBulkItem(mediaFileId, () => refreshOne(mediaFileId, context), "media_file.refresh_failed"));
		}

		return { results };
	});
}

export async function refreshAll(state: MediaServiceState, context?: AdminAuditContext) {
	return await runSafely(state, "refreshAll", async () => {
		const enqueued = await enqueueDeduped({
			targets: [{ workerId: "media-files-refresh-all", dedupeKey: "media-files-refresh-all" }],
			type: "media-files-refresh",
			reference: { type: "media-files", id: "all" },
			label: "all media files refresh",
			enqueue: (operationId) => enqueueAllMediaFilesRefresh({ operationId }),
			onDeduped: () => state.logger.info("Media refresh-all is already running — the request was folded into the active sweep"),
		});

		recordAuditSafe(
			{
				action: "update",
				resourceType: "media_files_refresh_all",
				after: { operationId: enqueued.operationId },
				context,
			},
			state.logger,
		);

		return enqueued;
	});
}
