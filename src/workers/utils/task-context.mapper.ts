import type { WorkerHandlerContext } from "@reelvault/sdk/common";
import type { ApplicationContext } from "@/utils/task-context.types";

/**
 * Maps the worker handler context to the task context: the correlation id is
 * the operation id by definition, so the two never drift apart per worker.
 */
export function toApplicationContext(context: WorkerHandlerContext): ApplicationContext {
	return {
		signal: context.signal,
		logger: context.logger,
		operationId: context.operationId,
		correlationId: context.operationId,
		taskId: context.taskId,
		extendTimeout: context.extendTimeout,
		updateProgress: context.updateProgress,
	};
}
