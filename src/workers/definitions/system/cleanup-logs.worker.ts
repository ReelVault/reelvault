import { MINUTE } from "@/config/server/server.constants";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";
import { workerDependencies } from "@/workers/worker.ports";

export const cleanupLogsWorker = defineMaintenanceWorker({
	id: "clean-up-logs",
	category: "file_cleanup",
	timeoutMs: MINUTE,
	trigger: { id: "clean-logs-daily", type: "daily", timeOfDay: "03:00" },
	run: async ({ signal }) => {
		const result = await workerDependencies().services.adminLogs.purgeOldLogs(undefined, undefined, signal);

		return { success: true, ...result };
	},
});
