import { and, eq, ne, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { operations, updateOperation } from "./shared.types";

/**
 * Keeps a streaming-session operation alive while its ffmpeg process runs,
 * past the short-lived stream-init job. Called once per session by the
 * progress monitor (which guards against seek-restart double-counting), so it
 * always claims a slot here — including while the stream-init job is still
 * `running`, otherwise that job's completion would terminalize the operation.
 * Returns false when the operation was cancelled in the meantime — a late
 * attach must never resurrect a terminal operation.
 */
export async function markStreamAttached(operationId: string): Promise<boolean> {
	const updated = await databaseFactory
		.getClient()
		.update(operations)
		.set({
			status: "running",
			runningItems: sql`${operations.runningItems} + 1`,
			completedAt: null,
			updatedAt: new Date(),
		})
		.where(and(eq(operations.id, operationId), eq(operations.cancelRequested, false), ne(operations.status, "cancelled")))
		.returning({ id: operations.id });

	return updated.length > 0;
}

/** Releases the streaming slot counter — the reaper calls this on session teardown. */
export async function releaseStreamSlot(operationId: string): Promise<void> {
	await updateOperation(operationId, {
		runningItems: sql`MAX(${operations.runningItems} - 1, 0)`,
		updatedAt: new Date(),
	});
}

/**
 * Closes the slot after a natural ffmpeg EOF: when no other work is pending
 * the operation terminalizes as completed at 100%. Kills (seek, release) keep
 * the slot with the session — the reaper finalizes those.
 */
export async function completeStreamSlot(operationId: string): Promise<void> {
	const now = new Date();
	const newRunning = sql`MAX(${operations.runningItems} - 1, 0)`;
	const newFinished = sql`(${operations.completedItems} + ${operations.failedItems} + ${operations.cancelledItems})`;
	// Cancellation always wins: a natural EOF on a cancelled operation must not
	// flip it back to `completed` (same rule as the job-level status SQL).
	const isIdleAndDone = sql`(${newRunning} = 0 AND ${operations.totalItems} > 0 AND ${newFinished} >= ${operations.totalItems}
		AND NOT ${operations.cancelRequested} AND ${operations.status} != 'cancelled')`;

	await updateOperation(operationId, {
		runningItems: newRunning,
		status: sql`CASE WHEN ${isIdleAndDone} THEN 'completed' ELSE ${operations.status} END`,
		completedAt: sql`CASE WHEN ${isIdleAndDone} THEN ${Math.floor(now.getTime() / 1000)} ELSE ${operations.completedAt} END`,
		updatedAt: now,
	});
}
