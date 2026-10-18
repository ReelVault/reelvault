import { MINUTE } from "@/config/server/server.constants";
import { workerDependencies } from "@/workers/worker.ports";
import { createWorkerDefinition } from "@/workers/worker.types";

export const cleanupPluginBlobsWorker = createWorkerDefinition(
	"clean-up-plugin-blobs",
	() => ({
		category: "file_cleanup",
		concurrency: 1,
		timeoutMs: MINUTE,
	}),
	async ({ signal }) => {
		await workerDependencies().services.pluginBlobs.purgeExpired(signal);

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
