import type { Logger } from "@reelvault/sdk/common";

export interface TaskSchedulingOptions {
	operationId?: string | undefined;
	dependsOnTaskIds?: string[] | undefined;
}

export interface ApplicationContext {
	signal?: AbortSignal | undefined;
	correlationId?: string | undefined;
	operationId?: string | undefined;
	taskId?: string | undefined;
	logger?: Logger | undefined;
	/** Re-arms the execution timeout (see WorkerHandlerContext.extendTimeout). */
	extendTimeout?: ((additionalMs: number) => void) | undefined;
	/** Reports the job's percent to its operation (see WorkerHandlerContext.updateProgress). */
	updateProgress?: ((percent: number) => Promise<void>) | undefined;
}
