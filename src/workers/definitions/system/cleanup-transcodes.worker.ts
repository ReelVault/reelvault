import { streamingService } from "@/modules/streaming/runtime/streaming.manager";
import { cleanupStartupDirectories } from "@/utils/server-data.utils";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { createWorkerDefinition } from "@/workers/worker.types";

export const cleanupTranscodesWorker = createWorkerDefinition(
	"clean-up-transcodes",
	() => ({
		category: "file_cleanup",
		concurrency: 1,
		timeoutMs: 120_000,
	}),
	async ({ signal }) => {
		throwIfAborted(signal);
		// Deleting the tempDir of a live session breaks playback mid-stream (paused
		// sessions keep their heartbeat alive far longer than this interval), so the
		// sweep skips every directory belonging to an active session.
		const activeSessionIds = new Set(streamingService.getAllActiveSessions().map((session) => session.id));
		await cleanupStartupDirectories(undefined, activeSessionIds, signal);

		return { success: true };
	},
);

cleanupTranscodesWorker.defaultTriggers = [
	{
		id: "clean-trans-interval",
		type: "interval",
		intervalMinutes: 360,
	},
];
