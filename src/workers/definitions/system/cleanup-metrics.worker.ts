import { MINUTE } from "@/config/server/server.constants";
import { resourceMetricsRepository } from "@/repositories/resource-metrics.repository";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";

export const cleanupMetricsWorker = defineMaintenanceWorker({
	id: "clean-up-resource-metrics",
	category: "database_optimization",
	timeoutMs: MINUTE,
	trigger: { id: "clean-metrics-daily", type: "daily", timeOfDay: "02:15" },
	run: async () => {
		// Each row carries its own retention_until (created_at + 24 h); deleting by
		// that column honours the schema's retention promise instead of a separate
		// fixed window — a hard-coded 30-day cutoff kept ~90k stale rows alive.
		const cutoff = new Date();
		const deletedCount = await resourceMetricsRepository.cleanupOlderThan(cutoff);

		return { deletedMetricsCount: deletedCount };
	},
});
