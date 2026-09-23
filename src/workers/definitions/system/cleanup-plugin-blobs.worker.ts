import { pluginBlobsService } from "@/plugins/capabilities/plugin.blobs";
import { MINUTE } from "@/server.constants";
import { createWorkerDefinition } from "@/workers/worker.types";

export const cleanupPluginBlobsWorker = createWorkerDefinition(
	"clean-up-plugin-blobs",
	() => ({
		category: "file_cleanup",
		concurrency: 1,
		timeoutMs: MINUTE,
	}),
	async ({ signal }) => {
		await pluginBlobsService.purgeExpired(signal);

		return { success: true };
	},
);

cleanupPluginBlobsWorker.defaultTriggers = [
	{
		id: "clean-blobs-daily",
		type: "daily",
		timeOfDay: "02:30",
	},
];
