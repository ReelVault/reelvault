import { MINUTE } from "@/config/server/server.constants";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { workerDependencies } from "@/workers/worker.ports";
import { createWorkerDefinition } from "@/workers/worker.types";

export const cleanupOrphanMediaFilesWorker = createWorkerDefinition(
	"clean-up-orphan-media-files",
	() => ({
		name: "Clean up orphaned media files",
		description: "Deletes media files whose parent library no longer exists (orphaned foreign keys).",
		category: "file_cleanup",
		concurrency: 1,
		timeoutMs: 5 * MINUTE,
	}),
	async ({ signal, logger }) => {
		throwIfAborted(signal);

		const orphanedIds = await workerDependencies().media.findOrphanedMediaFileIds();
		if (orphanedIds.length === 0) {
			return { deletedCount: 0, orphanedIds: [] };
		}

		logger.warn(`Found ${orphanedIds.length} orphaned media files (library deleted), cleaning up`);
		const deletedCount = await workerDependencies().media.deleteByIds(orphanedIds);
		logger.info(`Deleted ${deletedCount} orphaned media files`);

		return { deletedCount, orphanedIds };
	},
);

cleanupOrphanMediaFilesWorker.defaultTriggers = [
	{
		id: "clean-orphan-media-daily",
		type: "daily",
		timeOfDay: "03:45",
	},
];
