import { MemoryCache } from "@/utils/memory.cache";
import {
	cancelAllPending,
	cancelAllRunning,
	cancelPending,
	cancelPendingByOperation,
	cancelRunning,
	countCancelledByOperation,
	findActiveOperations,
	findByOperation,
	findCancelledByOperation,
	findRunningByOperation,
} from "./worker-jobs/cancellation.writer";
import { claimNextBatch, complete, fail, recoverOrphanedRunning, requeueRunning, retry, updateProgress } from "./worker-jobs/claims.writer";
import {
	enqueue,
	enqueueMany,
	findActiveByDedupeKey,
	findActiveByWorkerAndDedupeKeys,
	findItem,
	findPendingWorkerIds,
	listItems,
} from "./worker-jobs/intake.repository";
import { countTerminalJobs, getStats, purgeTerminalJobs, trim, trimMany } from "./worker-jobs/maintenance.writer";
import type { WorkerItemStats } from "./worker-jobs/shared.types";

export type { ActiveWorkerItem, WorkerItem, WorkerItemSummary } from "./worker-jobs/shared.types";

/**
 * Facade over the worker job queue. The behavior lives in `worker-jobs/`, grouped
 * by intake, claims, cancellation and maintenance; the class keeps the singleton API.
 */
class WorkerJobRepository {
	/**
	 * Worker dashboards aggregate the whole jobs table and poll frequently; a short
	 * cache avoids re-running the GROUP BY on every poll. Counts may lag by up to
	 * the TTL, which is acceptable for a status view.
	 */
	private readonly statsCache = new MemoryCache<WorkerItemStats[]>({
		ttlMs: 5_000,
		maxSize: 1,
		name: "worker-job-stats",
	});

	readonly enqueue = enqueue;
	readonly enqueueMany = enqueueMany;
	readonly findItem = findItem;
	readonly findActiveByDedupeKey = findActiveByDedupeKey;
	readonly findActiveByWorkerAndDedupeKeys = findActiveByWorkerAndDedupeKeys;
	readonly listItems = listItems;
	readonly findPendingWorkerIds = findPendingWorkerIds;
	readonly claimNextBatch = claimNextBatch;
	readonly updateProgress = updateProgress;
	readonly complete = complete;
	readonly retry = retry;
	readonly fail = fail;
	readonly cancelPending = cancelPending;
	readonly cancelRunning = cancelRunning;
	readonly requeueRunning = requeueRunning;
	readonly cancelPendingByOperation = cancelPendingByOperation;
	readonly findRunningByOperation = findRunningByOperation;
	readonly findByOperation = findByOperation;
	readonly findActiveOperations = findActiveOperations;
	readonly findCancelledByOperation = findCancelledByOperation;
	readonly countCancelledByOperation = countCancelledByOperation;
	readonly cancelAllPending = cancelAllPending;
	readonly cancelAllRunning = cancelAllRunning;
	readonly getStats = () => getStats(this.statsCache);
	readonly recoverOrphanedRunning = recoverOrphanedRunning;
	readonly trim = trim;
	readonly trimMany = trimMany;
	readonly purgeTerminalJobs = purgeTerminalJobs;
	readonly countTerminalJobs = countTerminalJobs;
}

export const workerJobRepository = new WorkerJobRepository();
