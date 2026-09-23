import { databaseFactory } from "@/database/database";
import { MINUTE } from "@/server.constants";
import { workerOperationsService } from "@/workers/core/worker-operations.service";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { createWorkerDefinition } from "@/workers/worker.types";

export const cleanupDatabaseWorker = createWorkerDefinition(
	"clean-up-database",
	() => ({
		category: "database_optimization",
		concurrency: 1,
		timeoutMs: MINUTE,
	}),
	async ({ signal }) => {
		throwIfAborted(signal);
		const deletedCount = await workerOperationsService.cleanupExpired();

		// Keep planner statistics fresh: stale stats made the paginated browse and
		// worker-claim queries pick a type index + TEMP B-TREE sort instead of the
		// composite indexes, degrading with catalog/backlog size.
		databaseFactory.analyze();

		return { deletedOperationsCount: deletedCount };
	},
);

cleanupDatabaseWorker.defaultTriggers = [
	{
		id: "clean-db-daily",
		type: "daily",
		timeOfDay: "02:00",
	},
];
