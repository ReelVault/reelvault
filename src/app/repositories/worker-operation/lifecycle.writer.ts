import { eq } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { DomainError } from "@/utils/domain.errors";
import { type CreateWorkerOperationInput, operations, updateOperation, type WorkerOperationRecord } from "./shared.types";

/** Creates an operation; one created with an `error` is born failed. */
export async function createOperation(input: CreateWorkerOperationInput): Promise<WorkerOperationRecord> {
	const [operation] = await databaseFactory
		.getClient()
		.insert(operations)
		.values({
			id: input.id,
			type: input.type,
			referenceType: input.referenceType,
			referenceId: input.referenceId,
			error: input.error,
			status: input.error ? "failed" : "pending",
		})
		.returning();
	if (!operation) throw new DomainError("internal", "Failed to create worker operation", { code: "worker.operation_create_failed" });

	return operation;
}

export async function removeOperation(id: string): Promise<void> {
	await databaseFactory.getClient().delete(operations).where(eq(operations.id, id));
}

/** Admin resume: clear the cancel request and re-arm the operation for its re-enqueued jobs. */
export async function markResumed(id: string, totalItems = 0): Promise<void> {
	await updateOperation(id, {
		cancelRequested: false,
		status: "pending",
		completedAt: null,
		// A resumed operation must not keep the terminal retention deadline:
		// the daily cleanup would delete it (and its jobs) mid-run.
		retentionUntil: null,
		// Reset counters so the re-enqueue's increments produce correct totals
		// instead of double-counting against the cancelled run. `totalItems` is
		// pre-set to the re-enqueue size so the operation cannot terminalize
		// after the first chunk completes.
		totalItems,
		pendingItems: 0,
		runningItems: 0,
		completedItems: 0,
		failedItems: 0,
		cancelledItems: 0,
		progressPercent: 0,
		updatedAt: new Date(),
	});
}

export async function requestCancel(id: string): Promise<void> {
	const now = new Date();
	await updateOperation(id, {
		cancelRequested: true,
		status: "cancelled",
		completedAt: now,
		updatedAt: now,
	});
}
