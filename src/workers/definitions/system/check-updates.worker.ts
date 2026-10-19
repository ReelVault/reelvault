import { MINUTE } from "@/config/server/server.constants";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";
import { workerDependencies } from "@/workers/worker.ports";

export const checkUpdatesWorker = defineMaintenanceWorker({
	id: "check-updates",
	category: "system",
	timeoutMs: 5 * MINUTE,
	trigger: { id: "check-updates-daily", type: "daily", timeOfDay: "08:30" },
	run: async ({ signal }) => {
		throwIfAborted(signal);
		const notified = await workerDependencies().services.updateNotifications.notifyIfUpdateAvailable(true);

		return { success: true, notified };
	},
});
