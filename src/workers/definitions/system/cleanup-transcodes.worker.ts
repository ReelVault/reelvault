import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { cleanupStartupDirectories } from "@/system/server-data.utils";
import { defineMaintenanceWorker } from "@/workers/utils/maintenance-worker.utils";

export const cleanupTranscodesWorker = defineMaintenanceWorker({
	id: "clean-up-transcodes",
	category: "file_cleanup",
	timeoutMs: 120_000,
	trigger: { id: "clean-trans-interval", type: "interval", intervalMinutes: 360 },
	run: async ({ signal }) => {
		// Deleting the tempDir of a live session breaks playback mid-stream (paused
		// sessions keep their heartbeat alive far longer than this interval), so the
		// sweep skips every directory belonging to an active session.
		const activeSessionIds = new Set(streamingManager.getAllActiveSessions().map((session) => session.id));
		await cleanupStartupDirectories(undefined, activeSessionIds, signal);

		return { success: true };
	},
});
