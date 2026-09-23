import type { TaskSchedulingOptions } from "@/application/context";

/**
 * Shared mapping from a worker's orchestration context (`{ operationId,
 * taskId }`) to the scheduling options used when enqueueing follow-up tasks.
 * Previously duplicated in the media-file-ingest and library-scan workers.
 */
export function toTaskSchedulingOptions(orchestration: {
	operationId?: string | undefined;
	taskId?: string | undefined;
}): TaskSchedulingOptions {
	if (!orchestration.operationId) return {};

	return {
		operationId: orchestration.operationId,
		dependsOnTaskIds: orchestration.taskId ? [orchestration.taskId] : undefined,
	};
}
