import { serverConfig } from "@/config/server/server.config";
import { mediaRepository } from "@/repositories/media-files.repository";
import { withDomainError } from "@/utils/domain.errors";
import type { ApplicationContext } from "@/utils/task-context.types";
import { scanAndEnqueueTask } from "@/workers/utils/scan-and-enqueue.service";
import { toApplicationContext } from "@/workers/utils/task-context.mapper";
import { defineWorkerEnqueue } from "@/workers/utils/worker-enqueue.utils";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";
import { enqueueMediaFileRefreshBatch } from "./media-file-refresh-batch.service";

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
	async (context) => await refreshAllMediaFilesTask(toApplicationContext(context)),
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

const allMediaFilesRefreshEnqueue = defineWorkerEnqueue<Record<string, never>>(mediaFilesRefreshAllWorker.id, () => ({
	dedupeKey: "media-files-refresh-all",
	reference: { type: "media-files", id: "all" },
}));

export function enqueueAllMediaFilesRefresh(options: WorkerEnqueueOptions = {}) {
	return allMediaFilesRefreshEnqueue.enqueue({}, options);
}
