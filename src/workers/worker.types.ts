import type { AddWorkerItemOptions, WorkerCategory, WorkerDefinition, WorkerHandlerContext } from "@reelvault/sdk";

export type WorkerEnqueueOptions = Pick<AddWorkerItemOptions, "operationId" | "dependsOnTaskIds" | "dependsOnJobId">;

export interface BackoffConfig {
	readonly type: "fixed" | "exponential";
	readonly delayMs: number;
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
		handler,
	};
}
