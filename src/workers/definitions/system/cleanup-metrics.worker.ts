import { resourceMetricsRepository } from "@/database/repositories/resource-metrics.repository";
import { daysAgo, MINUTE } from "@/server.constants";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { createWorkerDefinition } from "@/workers/worker.types";

export const cleanupMetricsWorker = createWorkerDefinition(
	"clean-up-resource-metrics",
	() => ({
		category: "database_optimization",
		concurrency: 1,
		timeoutMs: MINUTE,
	}),
	async ({ signal }) => {
		throwIfAborted(signal);
		const cutoff = daysAgo(30);
		const deletedCount = await resourceMetricsRepository.cleanupOlderThan(cutoff);

		return { deletedMetricsCount: deletedCount };
	},
);

cleanupMetricsWorker.defaultTriggers = [
	{
		id: "clean-metrics-daily",
		type: "daily",
		timeOfDay: "02:15",
	},
];
