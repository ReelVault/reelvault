import { type MediaFileAuditResponse, MediaFileAuditResponseSchema, type MediaFileAuditStatus } from "@reelvault/sdk/common";
import { readCompletedOperationResult } from "@/repositories/worker-jobs/result.reader";
import { recordAuditSafe } from "@/services/admin/admin-audit.service";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { DomainError } from "@/utils/domain.errors";
import { MemoryCache } from "@/utils/memory.cache";
import { runSafely } from "@/utils/safe-execute.utils";
import { enqueueMediaFileAuditReport } from "@/workers/definitions/media/media-file-audit.worker";
import { enqueueDeduped } from "@/workers/utils/enqueue-deduped.utils";
import { workerService } from "@/workers/worker.service";
import { mediaFilesLog } from "./media-files.logger";

/**
 * Validated audit reports by operation id. A completed operation's result is
 * immutable, but the client polls it repeatedly; without this, every poll
 * re-parsed and re-validated the whole report against the TypeBox schema.
 */
const auditResultCache = new MemoryCache<MediaFileAuditResponse>({ ttlMs: -1, maxSize: 8, name: "media-file-audit-results" });

/** Queues the full-catalog audit as a background operation (route returns 202). */
export async function queueAudit(context?: AdminAuditContext): Promise<{ success: true; operationId: string; status: "pending" }> {
	return await runSafely(mediaFilesLog, "queueAudit", async () => {
		const enqueued = await enqueueDeduped({
			targets: [{ workerId: "media-files-audit", dedupeKey: "media-files-audit:all" }],
			type: "media-files-audit",
			reference: { type: "media-files", id: "all" },
			label: "media file audit",
			enqueue: (operationId) => enqueueMediaFileAuditReport({ operationId }),
			onDeduped: () => mediaFilesLog.logger.info("Media audit is already running — the request was folded into the active sweep"),
		});

		recordAuditSafe(
			{
				action: "create",
				resourceType: "media_file_audit",
				resourceId: "all",
				after: { operationId: enqueued.operationId, status: "pending" },
				context,
			},
			mediaFilesLog.logger,
		);

		return enqueued;
	});
}

/** Polls an audit operation; `result` is populated once it completes. */
export async function getAuditStatus(operationId: string): Promise<MediaFileAuditStatus> {
	return await runSafely(mediaFilesLog, "getAuditStatus", async () => {
		const operation = await workerService.getOperation(operationId);
		if (operation?.type !== "media-files-audit") {
			throw new DomainError("not_found", "Audit operation not found", { code: "media_file.audit_not_found" });
		}

		let result: MediaFileAuditResponse | null = null;
		if (operation.status === "completed") {
			const cached = auditResultCache.get(operationId);
			if (cached) {
				result = cached;
			} else {
				result = await readCompletedOperationResult(operationId, MediaFileAuditResponseSchema);
				if (result) auditResultCache.set(operationId, result);
			}
		}

		return {
			status: operation.status,
			progressPercent: operation.progressPercent,
			result,
		};
	});
}
