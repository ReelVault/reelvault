import { type ApplicationContext, withDomainError } from "@/application/context";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { PromiseUtils } from "@/utils/promise.utils";
import { scanAndEnqueueTask } from "@/workers/utils/scan-and-enqueue";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";
import { enqueueMediaFileRefreshBatch } from "./media-file-refresh-batch";

export interface MediaFilesRefreshAllResult {
	requested: number;
	queued: number;
}

export interface MediaFilesRefreshAllTaskDependencies {
	findAll(): Promise<Array<{ id: string; metadataId: string }>>;
}

const defaultDependencies: MediaFilesRefreshAllTaskDependencies = {
	findAll: () => mediaRepository.findAllIdentities(),
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
	scheduleRefresh?: (mediaFileId: string, metadataId: string) => Promise<unknown>,
	dependencies: MediaFilesRefreshAllTaskDependencies = defaultDependencies,
): Promise<MediaFilesRefreshAllResult> {
	return withDomainError("All media file refreshes failed", async () => {
		if (scheduleRefresh) {
			const startedAt = performance.now();
			const mediaFiles = await dependencies.findAll();
			let queued = 0;
			await PromiseUtils.mapConcurrent(
				mediaFiles,
				systemResourcesService.getIngestConcurrency(),
				async ({ id, metadataId }) => {
					await scheduleRefresh(id, metadataId);
					queued++;
				},
				context.signal,
			);

			context.logger?.info("All media file refreshes queued", {
				requested: mediaFiles.length,
				queued,
				durationMs: Math.round(performance.now() - startedAt),
			});

			return { requested: mediaFiles.length, queued };
		}

		return scanAndEnqueueTask<{ id: string; metadataId: string }>({
			context,
			findIds: () => dependencies.findAll(),
			enqueueItem: async (item, options) => {
				await enqueueMediaFileRefreshBatch([item], options);
			},
			enqueueMany: (items, options) => enqueueMediaFileRefreshBatch(items, options),
			label: "All media file refreshes queued",
		});
	});
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
