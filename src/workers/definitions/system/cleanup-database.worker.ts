import { databaseFactory } from "@/database/database";
import { adminAuditRepository } from "@/database/repositories/admin-audit.repository";
import { watchedHistoryRepository } from "@/database/repositories/watched-history.repository";
import { serverConfig } from "@/server.config";
import { daysAgo, MINUTE } from "@/server.constants";
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

		// 0 keeps the full play history — pruning is opt-in via the retention setting.
		let prunedHistoryCount = 0;
		const historyRetentionDays = serverConfig.database.watchedHistoryRetentionDays;
		if (historyRetentionDays > 0) {
			prunedHistoryCount = await watchedHistoryRepository.pruneOlderThan(daysAgo(historyRetentionDays));
		}

		// Audit rows carry JSON snapshots and previously grew unbounded; default
		// retention is 180 days, 0 keeps everything.
		let prunedAuditCount = 0;
		const auditRetentionDays = serverConfig.database.auditRetentionDays;
		if (auditRetentionDays > 0) {
			prunedAuditCount = await adminAuditRepository.pruneOlderThan(daysAgo(auditRetentionDays));
		}

		// Keep planner statistics fresh: stale stats made the paginated browse and
		// worker-claim queries pick a type index + TEMP B-TREE sort instead of the
		// composite indexes, degrading with catalog/backlog size.
		databaseFactory.analyze();
		databaseFactory.optimizeFts();

		return { deletedOperationsCount: deletedCount, prunedHistoryCount, prunedAuditCount };
	},
);

cleanupDatabaseWorker.defaultTriggers = [
	{
		id: "clean-db-daily",
		type: "daily",
		timeOfDay: "02:00",
	},
];
