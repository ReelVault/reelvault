import { MINUTE } from "@/config/server/server.constants";
import { imageMaintenanceService } from "@/modules/images/image-maintenance.service";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";

export const cleanupOrphanImagesWorker = defineMaintenanceWorker({
	id: "clean-up-orphan-images",
	category: "database_optimization",
	timeoutMs: 120_000,
	trigger: { id: "clean-orphan-images-daily", type: "daily", timeOfDay: "03:30" },
	run: async ({ signal }) => {
		const result = await imageMaintenanceService.purgeOrphanedImages({ minAgeMs: 10 * MINUTE }, signal);

		return { success: true, ...result };
	},
});
