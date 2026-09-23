import { ConflictError, InternalError } from "@/utils/errors";

/** Result shared by every scan/refresh trigger endpoint. */
export interface DedupedEnqueue {
	success: true;
	operationId: string;
	status: "pending";
}

interface DedupeTarget {
	workerId: string;
	dedupeKey: string;
}

/**
 * Shared "skip when an equivalent task is already active, else enqueue under a
 * tracked operation" flow behind every scan/refresh trigger.
 *
 * `targets` are checked in order — an active task for any of them short-circuits
 * the enqueue. `enqueue` must return the created task; a task without its
 * operation id attached is treated as an internal inconsistency.
 */
export async function enqueueDeduped(options: {
	targets: DedupeTarget[];
	type: string;
	reference: { type: string; id: string };
	/** Human-readable trigger name for the inconsistency error, e.g. `"library scan"`. */
	label: string;
	enqueue: (operationId: string) => Promise<{ operationId?: string | null | undefined }>;
}): Promise<DedupedEnqueue> {
	// Lazy import: worker.service pulls the whole worker graph, and this helper
	// is imported from application services that the worker graph also imports.
	const { workerService } = await import("@/workers/worker.service");

	for (const { workerId, dedupeKey } of options.targets) {
		const existing = await workerService.findActiveItem(workerId, dedupeKey);
		if (existing) {
			if (!existing.operationId) throw new InternalError(`Active ${options.label} has no operation`);

			return { success: true, operationId: existing.operationId, status: "pending" };
		}
	}

	try {
		const { result: operationId } = await workerService.enqueueUnderOperation(
			{ type: options.type, reference: options.reference },
			async (enqueuedOperationId) => {
				const enqueued = await options.enqueue(enqueuedOperationId);
				if (!enqueued.operationId) throw new InternalError(`${options.label} operation was not attached to its task`);

				return enqueued.operationId;
			},
		);

		return { success: true, operationId, status: "pending" };
	} catch (error) {
		// The pre-check above races the insert: two concurrent triggers can both
		// pass it and one loses at the DB level. Any active equivalent task —
		// including one created by the losing trigger's winner — means the caller's
		// intent is already satisfied; otherwise the trigger is genuinely
		// un-serviceable right now, which is a conflict, not a 500.
		for (const { workerId, dedupeKey } of options.targets) {
			const existing = await workerService.findActiveItem(workerId, dedupeKey);
			if (existing) {
				if (!existing.operationId) throw new InternalError(`Active ${options.label} has no operation`);

				return { success: true, operationId: existing.operationId, status: "pending" };
			}
		}

		throw new ConflictError(`Could not enqueue ${options.label}`, { cause: error });
	}
}
