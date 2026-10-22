import { eq } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";

export type WorkerOperationRecord = typeof schema.workerOperations.$inferSelect;
export type WorkerOperationStatus = WorkerOperationRecord["status"];

/** An operation with its estimated time to completion. */
export interface WorkerOperation extends WorkerOperationRecord {
	etaMs: number | null;
}

export interface CreateWorkerOperationInput {
	id: string;
	type: string;
	referenceType?: string | undefined;
	referenceId?: string | undefined;
	error?: string | undefined;
}

export const operations = schema.workerOperations;
export const jobs = schema.workerJobs;

export const ACTIVE_STATUSES: WorkerOperationStatus[] = ["pending", "running"];
export const TERMINAL_STATUSES: WorkerOperationStatus[] = ["completed", "failed", "cancelled"];

/** Writes `values` to one operation, inside `tx` when given. */
export async function updateOperation(
	operationId: string,
	values: SQLiteUpdateSetSource<typeof operations>,
	tx?: DatabaseTransaction,
): Promise<void> {
	await databaseFactory.getClient({ tx }).update(operations).set(values).where(eq(operations.id, operationId));
}
