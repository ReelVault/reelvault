import { MINUTE } from "@/config/server/server.constants";
import { pluginBlobsService } from "@/plugins/capabilities/plugin.blobs";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";

export const cleanupPluginBlobsWorker = defineMaintenanceWorker({
	id: "clean-up-plugin-blobs",
	category: "file_cleanup",
	timeoutMs: MINUTE,
	trigger: { id: "clean-blobs-daily", type: "daily", timeOfDay: "02:30" },
	run: async ({ signal }) => {
		await pluginBlobsService.purgeExpired(signal);

		return { success: true };
	},
});
