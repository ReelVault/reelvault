import { and, asc, desc, eq, gt, inArray, type SQL } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { forEachChunked, mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { toMap, unique } from "@/utils/array.utils";
import { applyOperationCounts, items, RELEASE_CLAIM, runningJobWhere, toOperationCounts, type WorkerItem } from "./shared.types";

export async function cancelPending(id: string, tx?: DatabaseTransaction): Promise<boolean> {
	const client = databaseFactory.getClient({ tx });
	const now = new Date();
	// The guarded UPDATE reports both "missing" and "not pending" as an empty
	// result — the leading existence SELECT was redundant.
	const [updated] = await client
		.update(items)
		.set({ status: "cancelled", completedAt: now, updatedAt: now })
		.where(and(eq(items.id, id), eq(items.status, "pending")))
		.returning({ id: items.id, operationId: items.operationId });

	if (!updated) return false;

	if (updated.operationId) {
		await workerOperationRepository.markPendingJobsCancelled(updated.operationId, now, tx, 1);
	}

	if (tx) {
		await cascadeCancel(tx, [id], now);
	} else {
		await databaseFactory.transaction(async (innerTx) => {
			await cascadeCancel(innerTx, [id], now);
		});
	}

	return true;
}

/**
 * Cancels every pending dependent (transitively) of the given parent jobs,
 * set-based: one SELECT per dependency level, one bulk UPDATE, and one counter
 * update per affected operation. The old per-row recursion issued a query per
 * dependent and could stall the event loop for seconds on large operations.
 */
export async function cascadeCancel(tx: DatabaseTransaction, parentIds: string[], now: Date): Promise<void> {
	let frontier = parentIds;
	const affected: Array<{ id: string; operationId: string | null }> = [];

	while (frontier.length > 0) {
		const dependents = await mapChunked(frontier, (chunkIds) =>
			tx
				.select({ id: items.id, operationId: items.operationId })
				.from(items)
				.where(and(inArray(items.dependsOnJobId, chunkIds), eq(items.status, "pending"))),
		);

		if (dependents.length === 0) break;

		affected.push(...dependents);
		frontier = dependents.map((d) => d.id);
	}

	if (affected.length === 0) return;

	// A diamond-shaped dependency graph reaches a job from two levels; the UPDATE
	// runs once, so count each id once as well.
	const uniqueAffected = [...toMap(affected, (row) => row.id).values()];

	await forEachChunked(uniqueAffected, (chunkRows) =>
		tx
			.update(items)
			.set({ status: "cancelled", completedAt: now, updatedAt: now })
			.where(
				and(
					inArray(
						items.id,
						chunkRows.map((row) => row.id),
					),
					eq(items.status, "pending"),
				),
			),
	);

	await applyOperationCounts(toOperationCounts(uniqueAffected), (operationId, amount) =>
		workerOperationRepository.markPendingJobsCancelled(operationId, now, tx, amount),
	);
}

export async function cancelRunning(id: string, claimToken?: string): Promise<boolean> {
	const now = new Date();

	return await databaseFactory.transaction(
		async (tx) =>
			await terminalizeRunning(tx, {
				id,
				claimToken,
				values: { status: "cancelled", ...RELEASE_CLAIM, completedAt: now, updatedAt: now },
				afterUpdated: async (updatedJob, transaction) => {
					if (updatedJob.operationId) {
						await workerOperationRepository.markJobFinished(updatedJob.operationId, "cancelled", now, transaction);
					}
				},
			}),
	);
}

/**
 * Cancels every pending row matching `where`, cascades to their dependents and
 * lets the caller sync the operation counters — one set-based pass instead of a
 * query per row.
 */
async function cancelPendingWhere(
	where: SQL | undefined,
	now: Date,
	applyCounts: (tx: DatabaseTransaction, rows: Array<{ operationId: string | null }>) => Promise<void>,
): Promise<number> {
	return await databaseFactory.transaction(async (tx) => {
		const updated = await tx
			.update(items)
			.set({ status: "cancelled", completedAt: now, updatedAt: now })
			.where(where)
			.returning({ id: items.id, operationId: items.operationId });

		if (updated.length === 0) return 0;

		await cascadeCancel(
			tx,
			updated.map((row) => row.id),
			now,
		);
		await applyCounts(tx, updated);

		return updated.length;
	});
}

export async function cancelPendingByOperation(operationId: string): Promise<number> {
	const now = new Date();

	return await cancelPendingWhere(and(eq(items.operationId, operationId), eq(items.status, "pending")), now, async (tx, rows) => {
		await workerOperationRepository.markPendingJobsCancelled(operationId, now, tx, rows.length);
	});
}

export async function findRunningByOperation(operationId: string): Promise<WorkerItem[]> {
	return await databaseFactory
		.getClient()
		.select()
		.from(items)
		.where(and(eq(items.operationId, operationId), eq(items.status, "running")));
}

/** Jobs of an operation (newest first) — used to read a single-job operation's result. */
export async function findByOperation(operationId: string, limit = 1): Promise<WorkerItem[]> {
	return await databaseFactory
		.getClient()
		.select()
		.from(items)
		.where(eq(items.operationId, operationId))
		.orderBy(desc(items.createdAt))
		.limit(limit);
}

/** Active (pending/running) operation ids among the given set — batch probe for the session reaper. */
export async function findActiveOperations(operationIds: readonly string[], tx?: DatabaseTransaction): Promise<Set<string>> {
	const ids = unique(operationIds.filter(Boolean));
	if (ids.length === 0) return new Set();

	const rows = await mapChunked(ids, (chunkIds) =>
		databaseFactory
			.getClient({ tx })
			.selectDistinct({ operationId: items.operationId })
			.from(items)
			.where(and(inArray(items.operationId, chunkIds), inArray(items.status, ["pending", "running"]))),
	);

	return new Set(rows.map((row) => row.operationId).filter((operationId): operationId is string => operationId !== null));
}

/** Cancelled jobs of an operation — the re-enqueue source for admin "resume". */
export async function findCancelledByOperation(operationId: string, limit = 5000, afterId?: string): Promise<WorkerItem[]> {
	const conditions = [eq(items.operationId, operationId), eq(items.status, "cancelled")];
	if (afterId) conditions.push(gt(items.id, afterId));

	return await databaseFactory
		.getClient()
		.select()
		.from(items)
		.where(and(...conditions))
		.orderBy(asc(items.id))
		.limit(limit);
}

/** Cancelled-job count for an operation — pre-set as the resume total. */
export async function countCancelledByOperation(operationId: string): Promise<number> {
	return await databaseFactory.getClient().$count(items, and(eq(items.operationId, operationId), eq(items.status, "cancelled")));
}

export async function cancelAllPending(workerId?: string): Promise<number> {
	const now = new Date();
	const conditions = [eq(items.status, "pending")];
	if (workerId) conditions.push(eq(items.workerId, workerId));

	return await cancelPendingWhere(and(...conditions), now, async (tx, rows) => {
		// Keep operation counters in sync, decrementing pendingItems (not runningItems).
		await applyOperationCounts(toOperationCounts(rows), (operationId, amount) =>
			workerOperationRepository.markPendingJobsCancelled(operationId, now, tx, amount),
		);
	});
}

export async function cancelAllRunning(workerId?: string): Promise<number> {
	const now = new Date();
	const conditions = [eq(items.status, "running")];
	if (workerId) conditions.push(eq(items.workerId, workerId));

	return await databaseFactory.transaction(async (tx) => {
		// Counters come from the rows actually transitioned in the same
		// transaction — a pre-read snapshot could include a job that completed
		// between the SELECT and the UPDATE, skewing the operation counters.
		const cancelled = await tx
			.update(items)
			.set({ status: "cancelled", ...RELEASE_CLAIM, completedAt: now, updatedAt: now })
			.where(and(...conditions))
			.returning({ id: items.id, operationId: items.operationId });

		await applyOperationCounts(toOperationCounts(cancelled), (operationId, amount) =>
			workerOperationRepository.markJobFinished(operationId, "cancelled", now, tx, amount),
		);

		return cancelled.length;
	});
}

export async function terminalizeRunning(
	tx: DatabaseTransaction,
	{
		id,
		runnerId,
		claimToken,
		values,
		afterUpdated,
	}: {
		id: string;
		runnerId?: string | undefined;
		claimToken?: string | undefined;
		values: SQLiteUpdateSetSource<typeof items>;
		afterUpdated: (updatedJob: { operationId: string | null }, tx: DatabaseTransaction) => Promise<void>;
	},
): Promise<boolean> {
	const updated = await tx
		.update(items)
		.set(values)
		.where(runningJobWhere(id, runnerId, claimToken))
		.returning({ id: items.id, operationId: items.operationId });

	const updatedJob = updated[0];
	if (!updatedJob) return false;

	await afterUpdated(updatedJob, tx);

	return true;
}
