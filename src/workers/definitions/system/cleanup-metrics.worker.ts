import { resourceMetricsRepository } from "@/database/repositories/resource-metrics.repository";
import { MINUTE } from "@/server.constants";
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
		// Each row carries its own retention_until (created_at + 24 h); deleting by
		// that column honours the schema's retention promise instead of a separate
		// fixed window — a hard-coded 30-day cutoff kept ~90k stale rows alive.
		const cutoff = new Date();
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
