import type { FieldsQuery, MediaFileWithRelation, SelectFields, UpdateMediaFile } from "@reelvault/sdk/common";
import { mediaRepository } from "@/repositories/media-files.repository";
import { auditBeforeFields, auditedUpdate, recordAuditSafe } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { runBulkItems } from "@/services/catalog/catalog.utils";
import { mediaFilesLog } from "@/services/media/media-files/media-files.logger";
import { mediaFileRefreshService } from "@/services/media/media-files/refresh-media-file.operation";
import { assertFound } from "@/utils/domain.errors";
import { CATALOG_LIST_PATH_PREFIXES, invalidateResponseBodiesForPathPrefixes } from "@/utils/response-body.cache";
import { runSafely } from "@/utils/safe-execute.utils";
import { enqueueAllMediaFilesRefresh } from "@/workers/definitions/media/media-files-refresh-all.worker";
import { enqueueDeduped } from "@/workers/utils/enqueue-deduped.utils";

export async function update<F extends string>(
	mediaFileId: string,
	body: UpdateMediaFile,
	query?: FieldsQuery<F>,
	context?: AdminAuditContext,
): Promise<SelectFields<MediaFileWithRelation, F>> {
	return await runSafely(mediaFilesLog, "update", async () => {
		const result = await auditedUpdate({
			logger: mediaFilesLog.logger,
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

export async function refresh(mediaFileId: string, context?: AdminAuditContext) {
	return await runSafely(mediaFilesLog, "refresh", async () => {
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
			mediaFilesLog.logger,
		);

		return enqueued;
	});
}

/** Queues a technical refresh for each listed media file; a file that cannot be queued reports its own code. */
export async function refreshMany(mediaFileIds: string[], context?: AdminAuditContext) {
	return await runSafely(
		mediaFilesLog,
		"refreshMany",
		async () => await runBulkItems(mediaFileIds, (mediaFileId) => refresh(mediaFileId, context), "media_file.refresh_failed"),
	);
}

export async function refreshAll(context?: AdminAuditContext) {
	return await runSafely(mediaFilesLog, "refreshAll", async () => {
		const enqueued = await enqueueDeduped({
			targets: [{ workerId: "media-files-refresh-all", dedupeKey: "media-files-refresh-all" }],
			type: "media-files-refresh",
			reference: { type: "media-files", id: "all" },
			label: "all media files refresh",
			enqueue: (operationId) => enqueueAllMediaFilesRefresh({ operationId }),
			onDeduped: () => mediaFilesLog.logger.info("Media refresh-all is already running — the request was folded into the active sweep"),
		});

		recordAuditSafe(
			{
				action: "update",
				resourceType: "media_files_refresh_all",
				after: { operationId: enqueued.operationId },
				context,
			},
			mediaFilesLog.logger,
		);

		return enqueued;
	});
}
