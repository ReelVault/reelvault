import { MINUTE } from "@/config/server/server.constants";
import { mediaRepository } from "@/repositories/media-files.repository";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";

export const cleanupOrphanMediaFilesWorker = defineMaintenanceWorker({
	id: "clean-up-orphan-media-files",
	name: "Clean up orphaned media files",
	description: "Deletes media files whose parent library no longer exists (orphaned foreign keys).",
	category: "file_cleanup",
	timeoutMs: 5 * MINUTE,
	trigger: { id: "clean-orphan-media-daily", type: "daily", timeOfDay: "03:45" },
	run: async ({ logger }) => {
		const orphanedIds = await mediaRepository.findOrphanedMediaFileIds();
		if (orphanedIds.length === 0) {
			return { deletedCount: 0, orphanedIds: [] };
		}

		logger.warn(`Found ${orphanedIds.length} orphaned media files (library deleted), cleaning up`);
		const deletedCount = await mediaRepository.deleteByIds(orphanedIds);
		logger.info(`Deleted ${deletedCount} orphaned media files`);

		return { deletedCount, orphanedIds };
	},
});
