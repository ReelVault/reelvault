import { InternalError } from "@/utils/errors";

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

	const { result: operationId } = await workerService.enqueueUnderOperation(
		{ type: options.type, reference: options.reference },
		async (enqueuedOperationId) => {
			const enqueued = await options.enqueue(enqueuedOperationId);
			if (!enqueued.operationId) throw new InternalError(`${options.label} operation was not attached to its task`);

			return enqueued.operationId;
		},
	);

	return { success: true, operationId, status: "pending" };
}
