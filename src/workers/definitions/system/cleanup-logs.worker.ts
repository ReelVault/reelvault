import { MINUTE } from "@/config/server/server.constants";
import { adminLogsService } from "@/services/admin/admin-logs.service";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";

export const cleanupLogsWorker = defineMaintenanceWorker({
	id: "clean-up-logs",
	category: "file_cleanup",
	timeoutMs: MINUTE,
	trigger: { id: "clean-logs-daily", type: "daily", timeOfDay: "03:00" },
	run: async ({ signal }) => {
		const result = await adminLogsService.purgeOldLogs(undefined, undefined, signal);

		return { success: true, ...result };
	},
});
