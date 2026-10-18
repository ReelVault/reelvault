import type { MediaFileAuditResponse, MediaFileAuditStatus } from "@reelvault/sdk/common";
import { MediaFileAuditResponseSchema } from "@reelvault/sdk/common";
import { Value } from "@sinclair/typebox/value";
import { recordAuditSafe } from "@/app/admin/admin-audit.service";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { workerJobRepository } from "@/app/repositories/worker.repository";
import { DomainError } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import { enqueueMediaFileAuditReport } from "@/workers/definitions/media/media-file-audit.worker";
import { enqueueDeduped } from "@/workers/utils/enqueue-deduped.utils";
import { workerService } from "@/workers/worker.service";
import type { MediaServiceState } from "./shared.utils";

/** Queues the full-catalog audit as a background operation (route returns 202). */
export async function queueAudit(
	state: MediaServiceState,
	context?: AdminAuditContext,
): Promise<{ success: true; operationId: string; status: "pending" }> {
	return await runSafely(state, "queueAudit", async () => {
		const enqueued = await enqueueDeduped({
			targets: [{ workerId: "media-files-audit", dedupeKey: "media-files-audit:all" }],
			type: "media-files-audit",
			reference: { type: "media-files", id: "all" },
			label: "media file audit",
			enqueue: (operationId) => enqueueMediaFileAuditReport({ operationId }),
			onDeduped: () => state.logger.info("Media audit is already running — the request was folded into the active sweep"),
		});

		recordAuditSafe(
			{
				action: "create",
				resourceType: "media_file_audit",
				resourceId: "all",
				after: { operationId: enqueued.operationId, status: "pending" },
				context,
			},
			state.logger,
		);

		return enqueued;
	});
}

/** Polls an audit operation; `result` is populated once it completes. */
export async function getAuditStatus(state: MediaServiceState, operationId: string): Promise<MediaFileAuditStatus> {
	return await runSafely(state, "getAuditStatus", async () => {
		const operation = await workerService.getOperation(operationId);
		if (operation?.type !== "media-files-audit") {
			throw new DomainError("not_found", "Audit operation not found", { code: "media_file.audit_not_found" });
		}

		let result: MediaFileAuditResponse | null = null;
		if (operation.status === "completed") {
			const cached = state.auditResultCache.get(operationId);
			if (cached) {
				result = cached;
			} else {
				const [job] = await workerJobRepository.findByOperation(operationId, 1);
				if (job?.result) {
					const parsed: unknown = JSON.parse(job.result);
					if (Value.Check(MediaFileAuditResponseSchema, parsed)) {
						result = parsed;
						state.auditResultCache.set(operationId, parsed);
					}
				}
			}
		}

		return {
			status: operation.status,
			progressPercent: operation.progressPercent,
			result,
		};
	});
}
