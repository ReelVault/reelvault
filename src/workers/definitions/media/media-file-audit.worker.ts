import type { MediaFileAuditResponse } from "@reelvault/sdk/common";
import { type ApplicationContext, withDomainError } from "@/application/context";
import { auditMediaFileRow, buildMediaFileAuditReport } from "@/application/media/media-files/media-file-audit";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { serverConfig } from "@/server.config";
import { scanAndEnqueueTask } from "@/workers/utils/scan-and-enqueue";
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

		return await buildMediaFileAuditReport();
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
		if (!data.mediaFileId) throw new Error("Media file audit task requires a mediaFileId");

		const row = await mediaRepository.findAuditRow(data.mediaFileId);
		if (!row) return { mediaFileId: data.mediaFileId, suspect: false };

		return { mediaFileId: data.mediaFileId, suspect: auditMediaFileRow(row) !== null };
	});
}

export function scanMediaMatchAuditTask(context: ApplicationContext = {}): Promise<MediaMatchAuditScanResult> {
	return withDomainError("Media match audit scan failed", () =>
		scanAndEnqueueTask<string, MediaFileAuditData>({
			context,
			label: "Media match audit tasks queued",
			scanPages: (onPage) => mediaRepository.scanAuditRowIds(onPage),
			toData: (mediaFileId) => ({ mediaFileId }),
			enqueueItem: (data, options) => enqueueMediaFileAudit(data, options),
			enqueueMany: (items, options) => enqueueMediaFileAuditMany(items, options),
		}),
	);
}

/** Batched variant of {@link enqueueMediaFileAudit} — one INSERT batch instead of one per file. */
function enqueueMediaFileAuditMany(items: MediaFileAuditData[], options: WorkerEnqueueOptions) {
	return workerService.addItems(
		mediaFileAuditWorker.id,
		items.map((data) => ({
			data,
			options: { ...options, ...mediaFileAuditQueueOptions(data) },
		})),
	);
}

// ─── Enqueue Functions ────────────────────────────────────────────────────────

export function enqueueMediaFileAudit(data: MediaFileAuditData, options: WorkerEnqueueOptions = {}) {
	return workerService.addItem(mediaFileAuditWorker.id, data, { ...options, ...mediaFileAuditQueueOptions(data) });
}

function mediaFileAuditQueueOptions(data: MediaFileAuditData) {
	return {
		dedupeKey: `media-match-audit:${data.mediaFileId}`,
		reference: { type: "media-file", id: data.mediaFileId },
	};
}
