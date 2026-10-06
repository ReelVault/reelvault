import { workerJobRepository } from "@/database/repositories/worker.repository";
import { MINUTE } from "@/server.constants";
import { getWorkerRuntime } from "@/workers/core/worker-runtime";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition } from "@/workers/worker.types";

/** BullMQ-style semantics: `true` = keep none, number = keep N, false/undefined = no trim. */
function resolveKeepCount(value: number | boolean | undefined): number | undefined {
	if (value === undefined || value === false) return undefined;

	return value === true ? 0 : Math.max(0, Math.floor(value));
}

export const cleanupWorkerHistoryWorker = createWorkerDefinition(
	"clean-up-worker-history",
	() => ({
		category: "database_optimization",
		concurrency: 1,
		timeoutMs: MINUTE,
	}),
	async () => {
		const result = await workerService.purgeHistory({
			status: "all_terminal",
			olderThanDays: 7,
		});

		// Honour each worker's configured retention (removeOnComplete/removeOnFail)
		// for standalone jobs. `trimMany` excludes operation-grouped jobs, so this
		// never races the operation purge above — and it runs as one DELETE per
		// status instead of one DELETE per worker.
		const keepCompleted = new Map<string, number>();
		const keepFailed = new Map<string, number>();
		for (const definition of getWorkerRuntime().registry.getAll()) {
			const completed = resolveKeepCount(definition.removeOnComplete);
			if (completed !== undefined) keepCompleted.set(definition.id, completed);

			const failed = resolveKeepCount(definition.removeOnFail);
			if (failed !== undefined) keepFailed.set(definition.id, failed);
		}

		if (keepCompleted.size > 0) await workerJobRepository.trimMany("completed", keepCompleted);

		if (keepFailed.size > 0) await workerJobRepository.trimMany("failed", keepFailed);

		return result;
	},
);

cleanupWorkerHistoryWorker.defaultTriggers = [
	{
		id: "clean-worker-history-weekly",
		type: "weekly",
		dayOfWeek: 0,
		timeOfDay: "03:30",
	},
];
