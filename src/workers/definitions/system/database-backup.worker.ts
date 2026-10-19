import { serverConfig } from "@/config/server/server.config";
import { MINUTE } from "@/config/server/server.constants";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";
import { workerDependencies } from "@/workers/worker.ports";

export const databaseBackupWorker = defineMaintenanceWorker({
	id: "database-backup",
	category: "database_optimization",
	timeoutMs: 10 * MINUTE,
	trigger: { id: "database-backup-weekly", type: "weekly", dayOfWeek: 0, timeOfDay: "01:30" },
	run: async () => {
		const backup = await workerDependencies().services.databaseBackup.createBackup();

		// Retention honours system.database.backupRetentionCount — the prune inside
		// createBackup runs against the freshly written file, so the count check
		// sees the complete set.
		return { backupFileName: backup.fileName, sizeBytes: backup.sizeBytes, retention: serverConfig.database.backupRetentionCount };
	},
});
