import { MINUTE } from "@/config/server/server.constants";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { workerDependencies } from "@/workers/worker.ports";
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
		const result = await workerDependencies().services.adminLogs.purgeOldLogs(undefined, undefined, signal);

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
