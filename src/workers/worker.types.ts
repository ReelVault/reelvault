import type { AddWorkerItemOptions, TaskTrigger, WorkerCategory, WorkerDefinition, WorkerHandlerContext } from "@reelvault/sdk";
import type { BackoffConfig } from "@/config/server/workers.config";

export type WorkerEnqueueOptions = Pick<AddWorkerItemOptions, "operationId" | "dependsOnTaskIds" | "dependsOnJobId" | "priority">;

/** Filters accepted by the operation-job listings exposed through the worker service. */
export interface WorkerOperationJobsQuery {
	status?: "pending" | "running" | "completed" | "failed" | "cancelled" | undefined;
	q?: string | undefined;
	page?: number | undefined;
	limit?: number | undefined;
}

export function createWorkerDefinition<TData, TResult = unknown>(
	id: string,
	getConfig: () => {
		name?: string | undefined;
		description?: string | undefined;
		category?: WorkerCategory | undefined;
		concurrency?: number | undefined;
		timeoutMs?: number | undefined;
		attempts?: number | undefined;
		backoff?: BackoffConfig | undefined;
		removeOnComplete?: number | boolean | undefined;
		removeOnFail?: number | boolean | undefined;
	},
	handler: (context: WorkerHandlerContext<TData>) => Promise<TResult>,
	defaultTriggers?: TaskTrigger[],
): WorkerDefinition<TData, TResult> {
	return {
		id,
		get name() {
			return getConfig().name ?? id;
		},
		get description() {
			return getConfig().description;
		},
		get category() {
			return getConfig().category ?? "application";
		},
		get concurrency() {
			return getConfig().concurrency;
		},
		get timeoutMs() {
			return getConfig().timeoutMs;
		},
		get attempts() {
			return getConfig().attempts;
		},
		get backoff() {
			return getConfig().backoff;
		},
		get removeOnComplete() {
			return getConfig().removeOnComplete;
		},
		get removeOnFail() {
			return getConfig().removeOnFail;
		},
		defaultTriggers,
		handler,
	};
}
