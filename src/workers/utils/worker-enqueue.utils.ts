import type { AddWorkerItemOptions } from "@reelvault/sdk";
import type { WorkerItem } from "@/workers/worker.ports";
import { workerService } from "@/workers/worker.service";
import type { WorkerEnqueueOptions } from "@/workers/worker.types";

export interface WorkerEnqueue<TData> {
	/** Enqueues one task. */
	enqueue: (data: TData, options?: WorkerEnqueueOptions) => Promise<WorkerItem>;
	/** Enqueues many tasks in one batch — one INSERT instead of one per task. */
	enqueueMany: (entries: readonly TData[], options?: WorkerEnqueueOptions) => Promise<WorkerItem[]>;
}

/**
 * The enqueue pair of a worker: the single task and its batched variant, both
 * carrying the same per-task queue options (the dedupe key and the reference
 * the queue shows while the task runs).
 */
export function defineWorkerEnqueue<TData>(workerId: string, toQueueOptions: (data: TData) => AddWorkerItemOptions): WorkerEnqueue<TData> {
	const enqueue = (data: TData, options: WorkerEnqueueOptions = {}) =>
		workerService.addItem(workerId, data, { ...options, ...toQueueOptions(data) });
	const enqueueMany = (entries: readonly TData[], options: WorkerEnqueueOptions = {}) =>
		workerService.addItems(
			workerId,
			entries.map((data) => ({
				data,
				options: { ...options, ...toQueueOptions(data) },
			})),
		);

	return { enqueue, enqueueMany };
}
