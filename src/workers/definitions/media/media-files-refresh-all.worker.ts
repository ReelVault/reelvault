import { type ApplicationContext, withDomainError } from "@/application/context";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { serverConfig } from "@/server.config";
import { scanAndEnqueueTask } from "@/workers/utils/scan-and-enqueue";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";
import { enqueueMediaFileRefreshBatch } from "./media-file-refresh-batch";

export interface MediaFilesRefreshAllResult {
	requested: number;
	queued: number;
}

export interface MediaFilesRefreshAllTaskDependencies {
	scanAll(onPage: (rows: Array<{ id: string; metadataId: string }>) => Promise<void> | void): Promise<number>;
	enqueueBatch: typeof enqueueMediaFileRefreshBatch;
}

const defaultDependencies: MediaFilesRefreshAllTaskDependencies = {
	scanAll: (onPage) => mediaRepository.scanAllIdentities(onPage),
	enqueueBatch: enqueueMediaFileRefreshBatch,
};

// ─── Worker Definition ────────────────────────────────────────────────────────

export const mediaFilesRefreshAllWorker = createWorkerDefinition<Record<string, never>>(
	"media-files-refresh-all",
	() => serverConfig.workers.definitions.mediaFilesRefreshAll,
	async ({ logger, signal, operationId, taskId }) =>
		await refreshAllMediaFilesTask({ signal, logger, operationId, correlationId: operationId, taskId }),
);

// ─── Task Function ────────────────────────────────────────────────────────────

export function refreshAllMediaFilesTask(
	context: ApplicationContext,
	dependencies: MediaFilesRefreshAllTaskDependencies = defaultDependencies,
): Promise<MediaFilesRefreshAllResult> {
	return withDomainError(
		"All media file refreshes failed",
		async () =>
			await scanAndEnqueueTask<{ id: string; metadataId: string }, { id: string; metadataId: string }>({
				context,
				scanPages: (onPage) => dependencies.scanAll(onPage),
				toData: (item) => item,
				enqueueItem: async (item, options) => {
					await dependencies.enqueueBatch([item], options);
				},
				enqueueMany: (items, options) => dependencies.enqueueBatch(items, options),
				label: "All media file refreshes queued",
			}),
	);
}

// ─── Enqueue Function ─────────────────────────────────────────────────────────

export function enqueueAllMediaFilesRefresh(options: WorkerEnqueueOptions = {}) {
	return workerService.addItem(
		mediaFilesRefreshAllWorker.id,
		{},
		{
			...options,
			dedupeKey: "media-files-refresh-all",
			reference: { type: "media-files", id: "all" },
		},
	);
}
