import { updateNotificationService } from "@/application/updates/update-notification.service";
import { MINUTE } from "@/server.constants";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
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
		const notified = await updateNotificationService.notifyIfUpdateAvailable(true);

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
