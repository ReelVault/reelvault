import { imageMaintenanceService } from "@/modules/images/image-maintenance.service";
import { MINUTE } from "@/server.constants";
import { createWorkerDefinition } from "@/workers/worker.types";

export const cleanupOrphanImagesWorker = createWorkerDefinition(
	"clean-up-orphan-images",
	() => ({
		category: "database_optimization",
		concurrency: 1,
		timeoutMs: 120_000,
	}),
	async ({ signal }) => {
		const result = await imageMaintenanceService.purgeOrphanedImages({ minAgeMs: 10 * MINUTE }, signal);

		return { success: true, ...result };
	},
);

cleanupOrphanImagesWorker.defaultTriggers = [
	{
		id: "clean-orphan-images-daily",
		type: "daily",
		timeOfDay: "03:30",
	},
];
