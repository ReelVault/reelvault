import { count, eq, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { clamp } from "@/utils/math.utils";
import { jobs, operations, updateOperation } from "./shared.types";
import { buildCompletedAtCase, buildProgressPercentCase, buildStatusCase } from "./sql.builder";

/** Adds `amount` items to an operation's total, reopening it when it had already finished. */
export async function incrementTotalItems(operationId: string, amount: number, tx?: DatabaseTransaction): Promise<void> {
	if (amount <= 0) return;

	await databaseFactory
		.getClient({ tx })
		.update(operations)
		.set({
			totalItems: sql`${operations.totalItems} + ${amount}`,
			pendingItems: sql`${operations.pendingItems} + ${amount}`,
			// A late attach to a just-finished operation must reopen it: the new
			// job runs while the operation would otherwise stay terminal at 100%.
			status: sql`CASE WHEN ${operations.status} IN ('completed', 'failed') AND ${operations.cancelRequested} = false THEN 'pending' ELSE ${operations.status} END`,
			completedAt: sql`CASE WHEN ${operations.status} IN ('completed', 'failed') AND ${operations.cancelRequested} = false THEN null ELSE ${operations.completedAt} END`,
			updatedAt: new Date(),
		})
		.where(eq(operations.id, operationId));
}

export async function updateProgress(operationId: string, progressPercent: number, tx?: DatabaseTransaction): Promise<void> {
	await updateOperation(operationId, { progressPercent: clamp(Math.round(progressPercent), 0, 100), updatedAt: new Date() }, tx);
}

/**
 * Recomputes an operation's item counters from its actual jobs, in one
 * transaction. Used after a resume re-enqueue, where the pre-set total can
 * exceed the number of jobs that were actually inserted (unregistered worker,
 * dedupe conflict) and would otherwise never terminalize.
 */
export async function reconcileFromJobs(operationId: string): Promise<{ total: number }> {
	return await databaseFactory.transaction(async (tx) => {
		const rows = await tx
			.select({ status: jobs.status, amount: count() })
			.from(jobs)
			.where(eq(jobs.operationId, operationId))
			.groupBy(jobs.status);
		const [operation] = await tx
			.select({ cancelRequested: operations.cancelRequested })
			.from(operations)
			.where(eq(operations.id, operationId))
			.limit(1);

		const counts = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
		for (const row of rows) counts[row.status] = row.amount;

		// Cancelled rows are the pre-resume history (the re-enqueue inserts new
		// rows); counting them would double the total and immediately terminalize.
		const active = counts.pending + counts.running + counts.completed + counts.failed;
		const finished = counts.completed + counts.failed;
		const cancelRequested = operation?.cancelRequested === true;
		let status: "pending" | "running" | "completed" | "failed" | "cancelled";
		if (active === 0 || cancelRequested) {
			status = "cancelled";
		} else if (counts.running > 0) {
			status = "running";
		} else if (finished < active) {
			status = "pending";
		} else {
			status = counts.failed > 0 ? "failed" : "completed";
		}

		await updateOperation(
			operationId,
			{
				totalItems: active,
				pendingItems: counts.pending,
				runningItems: counts.running,
				completedItems: counts.completed,
				failedItems: counts.failed,
				cancelledItems: 0,
				status,
				completedAt: status === "pending" || status === "running" ? null : new Date(),
				progressPercent: active === 0 ? 100 : clamp(Math.round((finished / active) * 100), 0, 100),
				updatedAt: new Date(),
			},
			tx,
		);

		return { total: active };
	});
}

export async function markJobStarted(operationId: string, now: Date = new Date(), tx?: DatabaseTransaction, amount = 1): Promise<void> {
	if (amount <= 0) return;

	await updateOperation(
		operationId,
		{
			// UPDATE SET expressions see the pre-update row values in SQLite
			status: sql`CASE WHEN ${operations.status} = 'pending' THEN 'running' ELSE ${operations.status} END`,
			pendingItems: sql`MAX(${operations.pendingItems} - ${amount}, 0)`,
			runningItems: sql`${operations.runningItems} + ${amount}`,
			startedAt: sql`COALESCE(${operations.startedAt}, ${Math.floor(now.getTime() / 1000)})`,
			updatedAt: now,
		},
		tx,
	);
}

export async function markJobRetried(operationId: string, now: Date = new Date(), tx?: DatabaseTransaction, amount = 1): Promise<void> {
	if (amount <= 0) return;

	await updateOperation(
		operationId,
		{
			runningItems: sql`MAX(${operations.runningItems} - ${amount}, 0)`,
			pendingItems: sql`${operations.pendingItems} + ${amount}`,
			// A cancellation must win: a rescue/shutdown requeue of a running job
			// from an already-cancelled operation must not flip it back to `pending`.
			status: sql`CASE
				WHEN ${operations.cancelRequested} OR ${operations.status} = 'cancelled' THEN 'cancelled'
				WHEN MAX(${operations.runningItems} - ${amount}, 0) = 0 AND ${operations.completedItems} = 0 THEN 'pending'
				ELSE ${operations.status}
			END`,
			updatedAt: now,
		},
		tx,
	);
}

export async function markJobFinished(
	operationId: string,
	jobStatus: "completed" | "failed" | "cancelled",
	now: Date = new Date(),
	tx?: DatabaseTransaction,
	amount = 1,
): Promise<void> {
	if (amount <= 0) return;

	const newRunning = sql`MAX(${operations.runningItems} - ${amount}, 0)`;
	const newCompleted = sql`${operations.completedItems} + ${jobStatus === "completed" ? amount : 0}`;
	const newFailed = sql`${operations.failedItems} + ${jobStatus === "failed" ? amount : 0}`;
	const newCancelled = sql`${operations.cancelledItems} + ${jobStatus === "cancelled" ? amount : 0}`;
	const newFinished = sql`(${newCompleted} + ${newFailed} + ${newCancelled})`;
	const statusBranches = sql`WHEN ${newFinished} >= ${operations.totalItems} AND ${newRunning} = 0 THEN
						CASE
							WHEN ${operations.cancelRequested} OR ${newCancelled} > 0 THEN 'cancelled'
							WHEN ${newFailed} > 0 THEN 'failed'
							ELSE 'completed'
						END
					WHEN ${newRunning} = 0 AND ${operations.totalItems} - ${newFinished} > 0 THEN 'pending'`;

	await updateOperation(
		operationId,
		{
			runningItems: newRunning,
			completedItems: newCompleted,
			failedItems: newFailed,
			cancelledItems: newCancelled,
			// While a live streaming slot holds the operation open, the percent
			// belongs to the transcode progress monitor — a finishing job (the
			// seconds-long stream-init) must not stomp it back to the item ratio.
			progressPercent: buildProgressPercentCase(newRunning, newFinished),
			status: buildStatusCase(newRunning, statusBranches),
			completedAt: buildCompletedAtCase(newRunning, newFinished, now),
			updatedAt: now,
		},
		tx,
	);
}

/**
 * Cancels `amount` PENDING jobs of an operation. Unlike {@link markJobFinished}
 * this decrements `pendingItems` (not `runningItems`) — passing a pending count
 * to markJobFinished corrupted the running counter.
 */
export async function markPendingJobsCancelled(
	operationId: string,
	now: Date = new Date(),
	tx?: DatabaseTransaction,
	amount = 1,
): Promise<void> {
	if (amount <= 0) return;

	const newCancelled = sql`${operations.cancelledItems} + ${amount}`;
	const newFinished = sql`(${operations.completedItems} + ${operations.failedItems} + ${newCancelled})`;

	await updateOperation(
		operationId,
		{
			pendingItems: sql`MAX(${operations.pendingItems} - ${amount}, 0)`,
			cancelledItems: newCancelled,
			progressPercent: buildProgressPercentCase(operations.runningItems, newFinished),
			status: buildStatusCase(
				operations.runningItems,
				sql`WHEN ${newFinished} >= ${operations.totalItems} AND ${operations.runningItems} = 0 THEN 'cancelled'`,
			),
			completedAt: buildCompletedAtCase(operations.runningItems, newFinished, now),
			updatedAt: now,
		},
		tx,
	);
}
