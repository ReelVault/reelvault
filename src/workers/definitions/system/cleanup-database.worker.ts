import { serverConfig } from "@/config/server/server.config";
import { daysAgo, MINUTE } from "@/config/server/server.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { adminAuditRepository } from "@/repositories/admin-audit.repository";
import { interruptedPlaybackSessionRepository } from "@/repositories/interrupted-playback-session.repository";
import { watchedHistoryRepository } from "@/repositories/watched-history.repository";
import { workerOperationsService } from "@/workers/core/worker-operations.service";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";

export const cleanupDatabaseWorker = defineMaintenanceWorker({
	id: "clean-up-database",
	category: "database_optimization",
	timeoutMs: MINUTE,
	trigger: { id: "clean-db-daily", type: "daily", timeOfDay: "02:00" },
	run: async () => {
		const deletedCount = await workerOperationsService.cleanupExpired();

		// 0 keeps the full play history — pruning is opt-in via the retention setting.
		let prunedHistoryCount = 0;
		const historyRetentionDays = serverConfig.database.watchedHistoryRetentionDays;
		if (historyRetentionDays > 0) {
			const cutoff = daysAgo(historyRetentionDays);
			prunedHistoryCount = await watchedHistoryRepository.pruneOlderThan(cutoff);
			// Interrupted sessions follow the same retention as the rest of the play history.
			prunedHistoryCount += await interruptedPlaybackSessionRepository.pruneOlderThan(cutoff);
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
		// composite indexes, degrading with catalog/backlog size. Both run table by
		// table with a yield in between so maintenance never freezes HTTP.
		// awaits: sequential — analyze and FTS optimize run one after another on the same database
		await databaseFactory.analyzeChunked();
		await databaseFactory.optimizeFts();

		return { deletedOperationsCount: deletedCount, prunedHistoryCount, prunedAuditCount };
	},
});
