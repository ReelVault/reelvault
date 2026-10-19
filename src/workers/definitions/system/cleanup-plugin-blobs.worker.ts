import { MINUTE } from "@/config/server/server.constants";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";
import { workerDependencies } from "@/workers/worker.ports";

export const cleanupPluginBlobsWorker = defineMaintenanceWorker({
	id: "clean-up-plugin-blobs",
	category: "file_cleanup",
	timeoutMs: MINUTE,
	trigger: { id: "clean-blobs-daily", type: "daily", timeOfDay: "02:30" },
	run: async ({ signal }) => {
		await workerDependencies().services.pluginBlobs.purgeExpired(signal);

		return { success: true };
	},
});
