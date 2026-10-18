import { MINUTE } from "@/config/server/server.constants";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { workerDependencies } from "@/workers/worker.ports";
import { createWorkerDefinition } from "@/workers/worker.types";

export const checkUpdatesWorker = createWorkerDefinition(
	"check-updates",
	() => ({
		category: "system",
		concurrency: 1,
		timeoutMs: 5 * MINUTE,
	}),
	async ({ signal }) => {
		throwIfAborted(signal);
		const notified = await workerDependencies().services.updateNotifications.notifyIfUpdateAvailable(true);

		return { success: true, notified };
	},
);

checkUpdatesWorker.defaultTriggers = [
	{
		id: "check-updates-daily",
		type: "daily",
		timeOfDay: "08:30",
	},
];
