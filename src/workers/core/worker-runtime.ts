import type { AddWorkerItemOptions, WorkerDefinition } from "@sdk/common";
import type { ActiveWorkerItem, WorkerItem } from "@/database/repositories/worker.repository";
import { InternalError } from "@/utils/errors";

export interface WorkerRuntimeRegistry {
	get(workerId: string): WorkerDefinition | undefined;
	has(workerId: string): boolean;
	getAll(): WorkerDefinition[];
}

export interface WorkerRuntimePool {
	readonly totalRunningCount: number;
	runningCountFor(workerId: string): number;
	getActiveJobIds(): string[];
	cancel(jobId: string): void;
	cancelAllForWorker(workerId: string): number;
	start(definition: WorkerDefinition, item: WorkerItem): void | Promise<void>;
}

export interface WorkerRuntimeQueue {
	enqueue(workerId: string, data: unknown, options?: AddWorkerItemOptions): Promise<WorkerItem>;
	enqueueMany(workerId: string, entries: Array<{ data: unknown; options?: AddWorkerItemOptions }>): Promise<WorkerItem[]>;
	findActive(workerId: string, dedupeKey: string): Promise<ActiveWorkerItem | undefined>;
	cancelAllPending(workerId: string): Promise<number>;
}

/**
 * Shared handle to the worker subsystems the core services call back into.
 *
 * `worker.service` imports the core services to construct them; the core
 * services used to import `workerService` back, forming a runtime import cycle
 * that hit a TDZ on `BaseService` when a module graph entered through a core
 * service. The cycle is broken by handing the subsystems over here instead:
 * `WorkerService` registers them once, core services read them lazily.
 */
export interface WorkerRuntime {
	registry: WorkerRuntimeRegistry;
	pool: WorkerRuntimePool;
	queue: WorkerRuntimeQueue;
}

let runtime: WorkerRuntime | undefined;

export function setWorkerRuntime(next: WorkerRuntime): void {
	runtime = next;
}

export function getWorkerRuntime(): WorkerRuntime {
	if (!runtime) throw new InternalError("Worker runtime is not initialized");

	return runtime;
}
