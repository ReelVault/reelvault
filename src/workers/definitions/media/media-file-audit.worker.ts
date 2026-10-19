import type { MediaFileAuditResponse } from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";
import { DomainError, withDomainError } from "@/utils/domain.errors";
import type { ApplicationContext } from "@/utils/task-context.types";
import { scanAndEnqueueTask } from "@/workers/utils/scan-and-enqueue.service";
import { defineWorkerEnqueue } from "@/workers/utils/worker-enqueue.utils";
import { workerDependencies } from "@/workers/worker.ports";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

export interface MediaFileAuditData {
	mediaFileId: string;
}

export interface MediaFileAuditResult {
	mediaFileId: string;
	suspect: boolean;
}

export interface MediaMatchAuditScanResult {
	requested: number;
	queued: number;
}

// ─── Worker Definitions ───────────────────────────────────────────────────────

export const mediaFileAuditWorker = createWorkerDefinition<MediaFileAuditData>(
	"media-match-audit",
	() => serverConfig.workers.definitions.mediaMatchAudit,
	async ({ data, signal, operationId, taskId }) =>
		await auditMediaFileTask({ mediaFileId: data.mediaFileId }, { signal, operationId, correlationId: operationId, taskId }),
);

export const mediaMatchAuditScanWorker = createWorkerDefinition<Record<string, never>>(
	"media-match-audit-all",
	() => serverConfig.workers.definitions.mediaMatchAuditScan,
	async ({ signal, logger, operationId, taskId }) =>
		await scanMediaMatchAuditTask({ signal, logger, operationId, correlationId: operationId, taskId }),
);

mediaMatchAuditScanWorker.defaultTriggers = [{ id: "media-audit-weekly", type: "weekly", dayOfWeek: 0, timeOfDay: "04:30" }];

/**
 * Full-catalog audit run as a single operation job. The route returns 202 and the
 * client polls `getAuditStatus`; the handler returns the whole report as its result.
 */
export const mediaFileAuditReportWorker = createWorkerDefinition<Record<string, never>, MediaFileAuditResponse>(
	"media-files-audit",
	() => serverConfig.workers.definitions.mediaFileAuditReport,
	async ({ signal }) => {
		signal.throwIfAborted();

		return await workerDependencies().services.mediaAudit.buildReport();
	},
);

export function enqueueMediaFileAuditReport(options: WorkerEnqueueOptions = {}) {
	return workerService.addItem(
		mediaFileAuditReportWorker.id,
		{},
		{
			...options,
			dedupeKey: "media-files-audit:all",
			reference: { type: "media-files", id: "all" },
		},
	);
}

// ─── Task Functions ───────────────────────────────────────────────────────────

export function auditMediaFileTask(data: MediaFileAuditData, context: ApplicationContext = {}): Promise<MediaFileAuditResult> {
	return withDomainError(`Media file audit failed: ${data.mediaFileId}`, async () => {
		context.signal?.throwIfAborted();
		if (!data.mediaFileId)
			throw new DomainError("internal", "Media file audit task requires a mediaFileId", { code: "workers.media_file_audit_id_missing" });

		const suspect = await workerDependencies().services.mediaAudit.isSuspect(data.mediaFileId);

		return { mediaFileId: data.mediaFileId, suspect };
	});
}

// ─── Enqueue Functions ────────────────────────────────────────────────────────

const mediaFileAuditEnqueue = defineWorkerEnqueue<MediaFileAuditData>(mediaFileAuditWorker.id, (data) => ({
	dedupeKey: `media-match-audit:${data.mediaFileId}`,
	reference: { type: "media-file", id: data.mediaFileId },
}));

export const enqueueMediaFileAudit = mediaFileAuditEnqueue.enqueue;

/** Batched variant of {@link enqueueMediaFileAudit} — one INSERT batch instead of one per file. */
const enqueueMediaFileAuditMany = mediaFileAuditEnqueue.enqueueMany;

export function scanMediaMatchAuditTask(context: ApplicationContext = {}): Promise<MediaMatchAuditScanResult> {
	return withDomainError("Media match audit scan failed", () =>
		scanAndEnqueueTask<string, MediaFileAuditData>({
			context,
			label: "Media match audit tasks queued",
			scanPages: (onPage) => workerDependencies().media.scanAuditRowIds(onPage),
			toData: (mediaFileId) => ({ mediaFileId }),
			enqueueItem: (data, options) => enqueueMediaFileAudit(data, options),
			enqueueMany: (items, options) => enqueueMediaFileAuditMany(items, options),
		}),
	);
}
