import { serverConfig } from "@/config/server/server.config";
import { MINUTE } from "@/config/server/server.constants";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { workerDependencies } from "@/workers/worker.ports";
import { createWorkerDefinition } from "@/workers/worker.types";

export const databaseBackupWorker = createWorkerDefinition(
	"database-backup",
	() => ({
		category: "database_optimization",
		concurrency: 1,
		timeoutMs: 10 * MINUTE,
	}),
	async ({ signal }) => {
		throwIfAborted(signal);
		const backup = await workerDependencies().services.databaseBackup.createBackup();

		// Retention honours system.database.backupRetentionCount — the prune inside
		// createBackup runs against the freshly written file, so the count check
		// sees the complete set.
		return { backupFileName: backup.fileName, sizeBytes: backup.sizeBytes, retention: serverConfig.database.backupRetentionCount };
	},
);

databaseBackupWorker.defaultTriggers = [
	{
		id: "database-backup-weekly",
		type: "weekly",
		dayOfWeek: 0,
		timeOfDay: "01:30",
	},
];
