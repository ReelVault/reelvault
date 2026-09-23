import type { MediaFileAuditItem, MediaFileAuditResponse } from "@sdk/common/media-file.types";
import { type ApplicationContext, withDomainError } from "@/application/context";
import { auditMediaFileRow, buildMediaFileAuditReport } from "@/application/media/media-files/media-file-audit";
import { type MediaFileAuditRow, mediaRepository } from "@/database/repositories/media-files.repository";
import { serverConfig } from "@/server.config";
import { scanFanoutTask } from "@/workers/definitions/shared/scan-fanout";
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

export interface MediaFileAuditTaskDependencies {
	findAuditRow(mediaFileId: string): Promise<MediaFileAuditRow | undefined>;
	findAllAuditRowIds(): Promise<string[]>;
	auditRow(row: MediaFileAuditRow): MediaFileAuditItem | null;
	enqueue: (data: MediaFileAuditData, options: WorkerEnqueueOptions) => Promise<unknown>;
	/** Optional batched variant — used preferentially to avoid one INSERT per file. */
	enqueueMany?: (items: MediaFileAuditData[], options: WorkerEnqueueOptions) => Promise<unknown>;
}

// ─── Worker Definitions ───────────────────────────────────────────────────────

export const mediaFileAuditWorker = createWorkerDefinition<MediaFileAuditData>(
	"media-match-audit",
	() => serverConfig.workers.definitions.mediaMatchAudit,
	async ({ data, signal, operationId, taskId }) =>
		await auditMediaFileTask({ mediaFileId: data.mediaFileId }, { signal, operationId, correlationId: operationId, taskId }),
);

const defaultDependencies: MediaFileAuditTaskDependencies = {
	findAuditRow: (mediaFileId) => mediaRepository.findAuditRow(mediaFileId),
	findAllAuditRowIds: () => mediaRepository.findAllAuditRowIds(),
	auditRow: (row) => auditMediaFileRow(row),
	enqueue: enqueueMediaFileAudit,
	enqueueMany: (items, options) =>
		workerService.addItems(
			mediaFileAuditWorker.id,
			items.map((data) => ({
				data,
				options: {
					...options,
					dedupeKey: `media-match-audit:${data.mediaFileId}`,
					reference: { type: "media-file", id: data.mediaFileId },
				},
			})),
		),
};

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

export function auditMediaFileTask(
	data: MediaFileAuditData,
	context: ApplicationContext = {},
	dependencies: MediaFileAuditTaskDependencies = defaultDependencies,
): Promise<MediaFileAuditResult> {
	return withDomainError(`Media file audit failed: ${data.mediaFileId}`, async () => {
		context.signal?.throwIfAborted();
		if (!data.mediaFileId) throw new Error("Media file audit task requires a mediaFileId");

		const row = await dependencies.findAuditRow(data.mediaFileId);
		if (!row) return { mediaFileId: data.mediaFileId, suspect: false };

		return { mediaFileId: data.mediaFileId, suspect: dependencies.auditRow(row) !== null };
	});
}

export function scanMediaMatchAuditTask(
	context: ApplicationContext = {},
	dependencies: MediaFileAuditTaskDependencies = defaultDependencies,
): Promise<MediaMatchAuditScanResult> {
	const { enqueue, enqueueMany } = dependencies;

	return withDomainError("Media match audit scan failed", () =>
		scanFanoutTask<MediaFileAuditData>({
			context,
			label: "Media match audit tasks queued",
			findIds: () => dependencies.findAllAuditRowIds(),
			toData: (mediaFileId) => ({ mediaFileId }),
			enqueue: (...input) => enqueue(...input),
			...(enqueueMany ? { enqueueMany: (...input: Parameters<NonNullable<typeof enqueueMany>>) => enqueueMany(...input) } : {}),
		}),
	);
}

// ─── Enqueue Functions ────────────────────────────────────────────────────────

export function enqueueMediaFileAudit(data: MediaFileAuditData, options: WorkerEnqueueOptions = {}) {
	return workerService.addItem(mediaFileAuditWorker.id, data, {
		...options,
		dedupeKey: `media-match-audit:${data.mediaFileId}`,
		reference: { type: "media-file", id: data.mediaFileId },
	});
}
