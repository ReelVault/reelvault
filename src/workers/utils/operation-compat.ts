import { ConflictError } from "@/utils/errors";

/**
 * Rejects active worker tasks that belong to a different operation than the
 * one being enqueued. `undefined` operationId means no operation context, so
 * there is nothing to compare; tasks without an operation id are compatible.
 */
export function assertOperationCompatibility(
	tasks: ReadonlyArray<{ operationId: string | null }>,
	operationId: string | undefined,
	label: string,
): void {
	if (!operationId) return;

	for (const task of tasks) {
		if (task.operationId && task.operationId !== operationId) {
			throw new ConflictError(`Active ${label} belongs to another operation`);
		}
	}
}
