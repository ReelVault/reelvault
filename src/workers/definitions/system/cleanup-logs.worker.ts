import { adminLogsService } from "@/application/admin/admin-logs.service";
import { MINUTE } from "@/server.constants";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { createWorkerDefinition } from "@/workers/worker.types";

export const cleanupLogsWorker = createWorkerDefinition(
	"clean-up-logs",
	() => ({
		category: "file_cleanup",
		concurrency: 1,
		timeoutMs: MINUTE,
	}),
	async ({ signal }) => {
		throwIfAborted(signal);
		const result = await adminLogsService.purgeOldLogs(undefined, undefined, signal);

		return { success: true, ...result };
	},
);

cleanupLogsWorker.defaultTriggers = [
	{
		id: "clean-logs-daily",
		type: "daily",
		timeOfDay: "03:00",
	},
];
