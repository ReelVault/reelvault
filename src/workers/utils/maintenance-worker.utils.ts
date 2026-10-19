import type { TaskTrigger, WorkerCategory, WorkerDefinition, WorkerHandlerContext } from "@reelvault/sdk/common";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { createWorkerDefinition } from "@/workers/worker.types";

interface MaintenanceWorkerOptions<TResult> {
	id: string;
	category: WorkerCategory;
	timeoutMs: number;
	trigger: TaskTrigger;
	name?: string | undefined;
	description?: string | undefined;
	run: (context: WorkerHandlerContext) => Promise<TResult>;
}

/**
 * Built-in maintenance worker (cleanups, backup, update check): single
 * concurrency, one default trigger, the abort check and the shared definition
 * wiring, so each worker file only carries its schedule and its work.
 */
export function defineMaintenanceWorker<TResult>(options: MaintenanceWorkerOptions<TResult>): WorkerDefinition {
	const definition: WorkerDefinition = createWorkerDefinition(
		options.id,
		() => ({
			name: options.name,
			description: options.description,
			category: options.category,
			concurrency: 1,
			timeoutMs: options.timeoutMs,
		}),
		async (context) => {
			throwIfAborted(context.signal);

			return await options.run(context);
		},
	);
	definition.defaultTriggers = [options.trigger];

	return definition;
}
