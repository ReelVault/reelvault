import { workerJobRepository } from "@/database/repositories/worker.repository";
import { MINUTE } from "@/server.constants";
import { getWorkerRuntime } from "@/workers/core/worker-runtime";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition } from "@/workers/worker.types";

/** BullMQ-style semantics: `true` = keep none, number = keep N, false/undefined = no trim. */
function resolveKeepCount(value: number | boolean | undefined): number | undefined {
	if (value === undefined || value === false) return undefined;

	if (value === true) return 0;

	return Math.max(0, Math.floor(value));
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
		// for standalone jobs. `trim` excludes operation-grouped jobs, so this never
		// races the operation purge above.
		for (const definition of getWorkerRuntime().registry.getAll()) {
			const keepCompleted = resolveKeepCount(definition.removeOnComplete);
			const keepFailed = resolveKeepCount(definition.removeOnFail);
			if (keepCompleted !== undefined) await workerJobRepository.trim(definition.id, "completed", keepCompleted);

			if (keepFailed !== undefined) await workerJobRepository.trim(definition.id, "failed", keepFailed);
		}

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
