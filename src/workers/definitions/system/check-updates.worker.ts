import { MINUTE } from "@/config/server/server.constants";
import { updateNotificationService } from "@/services/updates/update-notification.service";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";

export const checkUpdatesWorker = defineMaintenanceWorker({
	id: "check-updates",
	category: "system",
	timeoutMs: 5 * MINUTE,
	trigger: { id: "check-updates-daily", type: "daily", timeOfDay: "08:30" },
	run: async () => {
		const notified = await updateNotificationService.notifyIfUpdateAvailable(true);

		return { success: true, notified };
	},
});
