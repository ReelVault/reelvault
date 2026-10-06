import { workerOperationsService } from "./worker-operations.service";

interface WorkerOperationInput {
	type: string;
	reference?: { type: string; id: string };
}

interface EnqueueWithOperationOptions<T> {
	/** Attach to an existing operation instead of creating (and owning) a new one. */
	operationId?: string | undefined;
	/**
	 * Reports whether the enqueue result attached to the operation. Only checked
	 * for operations this helper created: a dedupe hit returns the pre-existing
	 * row with its own operation, and the fresh one would linger `pending` with
	 * zero items forever.
	 */
	isAttached?: ((result: T, operationId: string) => boolean) | undefined;
	/** Extra best-effort cleanup (e.g. cancelling partially inserted jobs) before removing a created operation. */
	onFailure?: ((operationId: string) => Promise<unknown>) | undefined;
}

/** Best-effort operation removal — cleanup failures never mask the original error. */
async function removeOperationBestEffort(operationId: string): Promise<void> {
	await workerOperationsService.remove(operationId).catch(() => {
		// intentionally empty
	});
}

/**
 * Creates a worker operation when the caller does not supply one, runs the
 * enqueue with the effective operation id, and best-effort removes a freshly
 * created operation that ended up orphaned — either the enqueue failed or the
 * result deduped onto an existing row, so nothing references the new operation.
 *
 * Lives next to `worker-runtime` (not on `worker.service`) so the queue and
 * scheduler services can use it without importing `worker.service` back — that
 * runtime cycle hits a `BaseService` TDZ (see worker-runtime.ts).
 */
export async function enqueueWithOperation<T>(
	input: WorkerOperationInput,
	enqueue: (operationId: string) => Promise<T>,
	options: EnqueueWithOperationOptions<T> = {},
): Promise<{ operationId: string; result: T }> {
	const created = options.operationId === undefined;
	const operationId = options.operationId ?? (await workerOperationsService.create(input)).id;

	try {
		const result = await enqueue(operationId);

		if (created && options.isAttached && !options.isAttached(result, operationId)) {
			await removeOperationBestEffort(operationId);
		}

		return { operationId, result };
	} catch (error) {
		if (created) {
			if (options.onFailure) {
				await options.onFailure(operationId).catch(() => {
					// intentionally empty
				});
			}

			await removeOperationBestEffort(operationId);
		}

		throw error;
	}
}
