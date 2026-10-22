import { serverConfig } from "@/config/server/server.config";
import { MINUTE } from "@/config/server/server.constants";
import { subtitlesRepository } from "@/repositories/subtitles.repository";
import { scanFilesWithStats } from "@/utils/directory.utils";
import { deleteFile } from "@/utils/file.utils";
import { getFileNameWithoutExt } from "@/utils/path.utils";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";

/**
 * Extracted `<subtitleId>.vtt` renditions are deleted together with their row;
 * a crash between the write and the DB change (or a restored database) can leave
 * files with no row forever. The grace period covers an extraction that is still
 * running while the sweep walks the directory.
 */
const ORPHAN_MIN_AGE_MS = 10 * MINUTE;

export const cleanupOrphanSubtitlesWorker = defineMaintenanceWorker({
	id: "clean-up-orphan-subtitles",
	category: "file_cleanup",
	timeoutMs: 120_000,
	trigger: { id: "clean-orphan-subtitles-daily", type: "daily", timeOfDay: "03:45" },
	run: async ({ signal }) => {
		const files = await scanFilesWithStats(serverConfig.paths.subtitles, [".vtt"], 1, signal);
		if (files.length === 0) return { success: true, deleted: 0 };

		const subtitleIds = await subtitlesRepository.findAllIds();
		const now = Date.now();
		let deleted = 0;

		for (const file of files) {
			const subtitleId = getFileNameWithoutExt(file.filePath);
			if (subtitleIds.has(subtitleId)) continue;
			if (now - file.mtimeMs < ORPHAN_MIN_AGE_MS) continue;

			if (await deleteFile(file.filePath)) deleted += 1;
		}

		return { success: true, deleted };
	},
});
