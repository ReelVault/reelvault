import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { MINUTE } from "@/config/server/server.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { cancelPending, cascadeCancel, terminalizeRunning } from "./cancellation.writer";
import { loadParentStatuses } from "./intake.repository";
import {
	applyOperationCounts,
	type ClaimNextInput,
	items,
	operations,
	RELEASE_CLAIM,
	toOperationCounts,
	type WorkerItem,
} from "./shared.types";

/**
 * Claims every runnable job for one worker in a single transaction, up to
 * `max` — the sequential `claimNext` re-ran recover/candidates/counts and
 * fetched-and-discarded the same 20 candidates per claimed job, which made
 * draining a large enqueue cost ~5 queries per item. Claim semantics are
 * identical: per-row guarded UPDATE, in-transaction running count, dead
 * parents cancelled, per-operation counters incremented.
 */
export async function claimNextBatch(input: ClaimNextInput, max: number): Promise<WorkerItem[]> {
	if (max <= 0) return [];

	const { workerId, now } = input;
	const [pending] = await databaseFactory
		.getClient()
		.select({ id: items.id })
		.from(items)
		.where(and(eq(items.workerId, workerId), eq(items.status, "pending"), lte(items.runAt, now)))
		.limit(1);
	if (!pending) return [];

	return await databaseFactory.transaction(
		async (tx) => await claimRunnableItems(tx, input, max),
		// The claim reads candidates before it writes; a deferred BEGIN fails with
		// SQLITE_BUSY_SNAPSHOT when the main connection commits in that window.
		{ immediate: true },
	);
}

/** Claims one candidate row; the row is only claimed while it is still pending. */
async function claimCandidate(
	tx: DatabaseTransaction,
	candidate: { id: string },
	input: ClaimNextInput,
	now: Date,
): Promise<WorkerItem | undefined> {
	const [claimed] = await tx
		.update(items)
		.set({
			status: "running",
			attempts: sql`${items.attempts} + 1`,
			runnerId: input.runnerId,
			claimToken: crypto.randomUUID(),
			leaseUntil: new Date(now.getTime() + input.timeoutMs),
			startedAt: now,
			updatedAt: now,
		})
		.where(and(eq(items.id, candidate.id), eq(items.status, "pending")))
		.returning();

	return claimed;
}

/** Why a candidate cannot be claimed, or null when it can. */
function claimBlocker(
	candidate: { operationId?: string | null; dependsOnJobId?: string | null },
	parentStatuses: Map<string, string | undefined>,
	cancelledOperations: ReadonlySet<string>,
): "cancelled" | "parent-failed" | "parent-pending" | null {
	if (candidate.operationId && cancelledOperations.has(candidate.operationId)) return "cancelled";

	const parentStatus = candidate.dependsOnJobId ? parentStatuses.get(candidate.dependsOnJobId) : undefined;
	if (parentStatus === "failed" || parentStatus === "cancelled") return "parent-failed";
	if (parentStatus === "pending" || parentStatus === "running") return "parent-pending";

	return null;
}

/** One claim pass inside its transaction: recovers expired leases, then claims runnable candidates up to `max`. */
async function claimRunnableItems(tx: DatabaseTransaction, input: ClaimNextInput, max: number): Promise<WorkerItem[]> {
	const { workerId, concurrency, now } = input;
	await recoverExpired(workerId, now, tx, input.excludeActiveIds);

	// Claim decisions need only these columns — the arbitrary `data` JSON
	// payload would be materialized per poll for candidates it discards
	// (claimed rows return full data via the guarded UPDATE ... RETURNING).
	const candidates = await tx
		.select({
			id: items.id,
			workerId: items.workerId,
			operationId: items.operationId,
			dependsOnJobId: items.dependsOnJobId,
			attempts: items.attempts,
			maxAttempts: items.maxAttempts,
			priority: items.priority,
			runAt: items.runAt,
		})
		.from(items)
		.where(and(eq(items.workerId, workerId), eq(items.status, "pending"), lte(items.runAt, now)))
		.orderBy(asc(items.priority), asc(items.runAt), asc(items.createdAt))
		.limit(Math.max(max, 20, concurrency * 2));

	let runningCount = await tx.$count(items, and(eq(items.workerId, workerId), eq(items.status, "running")));

	const parentStatuses = await loadParentStatuses(candidates, tx);
	// A cancel request and this claim are separate statements: consult the
	// operations table so a job of a just-cancelled operation can never start.
	const operationIds = [...new Set(candidates.flatMap((candidate) => (candidate.operationId ? [candidate.operationId] : [])))];
	let cancelledOperationIds: string[] = [];
	if (operationIds.length > 0) {
		const cancelledRows = await tx
			.select({ id: operations.id })
			.from(operations)
			.where(and(inArray(operations.id, operationIds), or(eq(operations.cancelRequested, true), eq(operations.status, "cancelled"))));
		cancelledOperationIds = cancelledRows.map((row) => row.id);
	}
	const cancelledOperations = new Set(cancelledOperationIds);
	const startedByOperation = new Map<string, number>();

	const claimedItems: WorkerItem[] = [];
	for (const candidate of candidates) {
		if (claimedItems.length >= max) break;

		const blocker = claimBlocker(candidate, parentStatuses, cancelledOperations);
		if (blocker === "cancelled" || blocker === "parent-failed") {
			await cancelPending(candidate.id, tx);
			continue;
		}

		if (blocker === "parent-pending") {
			continue; // Prerequisite not finished yet (completed or gone → claimable)
		}

		if (runningCount >= concurrency) break;

		const claimed = await claimCandidate(tx, candidate, input, now);
		if (!claimed) continue;

		// Subsequent claims in this transaction must see the new running row.
		runningCount++;
		if (claimed.operationId) {
			startedByOperation.set(claimed.operationId, (startedByOperation.get(claimed.operationId) ?? 0) + 1);
		}

		claimedItems.push(claimed);
	}

	// One counter update per operation instead of one per claimed job.
	for (const [operationId, amount] of startedByOperation) {
		await workerOperationRepository.markJobStarted(operationId, now, tx, amount);
	}

	return claimedItems;
}

/**
 * Records a task's progress on its job row and on the operation that groups it.
 * Both rows move in one transaction: two independent writes let a crash between
 * them leave the operation's progress behind the job's.
 */
export async function updateProgress(id: string, progressPercent: number, claimToken?: string, operationId?: string): Promise<void> {
	await databaseFactory.transaction(async (tx) => {
		await tx
			.update(items)
			.set({ progressPercent, updatedAt: new Date() })
			.where(and(eq(items.id, id), ...(claimToken ? [eq(items.claimToken, claimToken)] : [])));

		if (operationId) await workerOperationRepository.updateProgress(operationId, progressPercent, tx);
	});
}

/**
 * Terminalizes a running job in one transaction: the guarded update and the
 * operation bookkeeping that follows it. `complete`, `retry` and `fail` differ
 * only in the values they write and in what the operation records afterwards.
 */
async function terminalizeJob(
	job: { id: string; runnerId: string; claimToken?: string | undefined },
	values: SQLiteUpdateSetSource<typeof items>,
	afterUpdated: (updatedJob: { operationId: string | null }, tx: DatabaseTransaction) => Promise<void>,
): Promise<boolean> {
	return await databaseFactory.transaction(async (tx) => await terminalizeRunning(tx, { ...job, values, afterUpdated }));
}

export async function complete(id: string, runnerId: string, result: string, claimToken?: string): Promise<boolean> {
	const now = new Date();

	return await terminalizeJob(
		{ id, runnerId, claimToken },
		{
			status: "completed",
			result,
			error: null,
			...RELEASE_CLAIM,
			progressPercent: 100,
			completedAt: now,
			updatedAt: now,
		},
		async (updatedJob, tx) => {
			if (updatedJob.operationId) {
				await workerOperationRepository.markJobFinished(updatedJob.operationId, "completed", now, tx);
			}
		},
	);
}

export async function retry(id: string, runnerId: string, runAt: Date, error: string, claimToken?: string): Promise<boolean> {
	const now = new Date();

	return await terminalizeJob(
		{ id, runnerId, claimToken },
		{
			status: "pending",
			runAt,
			error,
			// A retry starts fresh: stale progress/start/result from the failed
			// attempt must not show up in the admin UI while the job waits.
			progressPercent: null,
			startedAt: null,
			result: null,
			...RELEASE_CLAIM,
			updatedAt: now,
		},
		async (updatedJob, tx) => {
			if (updatedJob.operationId) await workerOperationRepository.markJobRetried(updatedJob.operationId, now, tx);
		},
	);
}

export async function fail(id: string, runnerId: string, error: string, claimToken?: string): Promise<boolean> {
	const now = new Date();

	return await terminalizeJob(
		{ id, runnerId, claimToken },
		{
			status: "failed",
			error,
			...RELEASE_CLAIM,
			completedAt: now,
			updatedAt: now,
		},
		async (updatedJob, tx) => {
			if (updatedJob.operationId) {
				await workerOperationRepository.markJobFinished(updatedJob.operationId, "failed", now, tx);
			}

			await cascadeCancel(tx, [id], now);
		},
	);
}

/** Returns an aborted running task to the queue with its attempt counter preserved (server rescue). */
export async function requeueRunning(id: string, runnerId: string, reason: string, claimToken?: string): Promise<boolean> {
	return await retry(id, runnerId, new Date(), reason, claimToken);
}

export async function recoverOrphanedRunning(options?: {
	excludeActiveIds?: string[];
	currentRunnerId?: string;
	foreignGraceMs?: number;
}): Promise<number> {
	const now = new Date();
	const client = databaseFactory.getClient();
	const fiveMinutesAgo = new Date(now.getTime() - 5 * MINUTE);

	const orphanConditions = [lt(items.leaseUntil, now), and(isNull(items.leaseUntil), lte(items.startedAt, fiveMinutesAgo))];
	// Single-instance deployment: any running row owned by a different runner is
	// dead (this process is the only writer). Recovered at boot so a crash does
	// not leave jobs `running` for the whole (possibly hours) lease duration.
	if (options?.currentRunnerId) {
		const foreignGraceAgo = new Date(now.getTime() - (options.foreignGraceMs ?? 30_000));
		orphanConditions.push(
			and(isNotNull(items.runnerId), ne(items.runnerId, options.currentRunnerId), lte(items.startedAt, foreignGraceAgo)),
		);
	}

	const conditions = [eq(items.status, "running"), or(...orphanConditions)];

	if (options?.excludeActiveIds && options.excludeActiveIds.length > 0) {
		conditions.push(notInArray(items.id, options.excludeActiveIds));
	}

	const expiredRows = await client
		.select({
			id: items.id,
			operationId: items.operationId,
			attempts: items.attempts,
			maxAttempts: items.maxAttempts,
		})
		.from(items)
		.where(and(...conditions));

	if (expiredRows.length === 0) return 0;

	return await databaseFactory.transaction(async (tx) => {
		return await recoverExpiredRows(tx, expiredRows, now);
	});
}

/** Requeues orphan rows with attempts left and fails the exhausted ones; returns how many rows were transitioned. */
async function recoverExpiredRows(
	tx: DatabaseTransaction,
	rows: Array<{ id: string; operationId: string | null; attempts: number; maxAttempts: number }>,
	now: Date,
): Promise<number> {
	const retryable = rows.filter((row) => row.attempts < row.maxAttempts);
	const exhausted = rows.filter((row) => row.attempts >= row.maxAttempts);

	return (await recoverRetryableRows(tx, retryable, now)) + (await recoverExhaustedRows(tx, exhausted, now));
}

/** Requeue selected orphan rows, re-checking `running` so a row that completed in the meantime cannot be resurrected. */
async function recoverRetryableRows(
	tx: DatabaseTransaction,
	rows: Array<{ id: string; operationId: string | null }>,
	now: Date,
): Promise<number> {
	const updated = await updateRunningRowsChunked(
		tx,
		rows.map((row) => row.id),
		{ status: "pending", ...RELEASE_CLAIM, updatedAt: now },
	);

	const recovered = rows.filter((row) => updated.has(row.id));
	await applyOperationCounts(toOperationCounts(recovered), (operationId, amount) =>
		workerOperationRepository.markJobRetried(operationId, now, tx, amount),
	);

	return updated.size;
}

/** Fail selected orphan rows that ran out of attempts, re-checking `running` and cascading to dependents. */
async function recoverExhaustedRows(
	tx: DatabaseTransaction,
	rows: Array<{ id: string; operationId: string | null }>,
	now: Date,
): Promise<number> {
	const updated = await updateRunningRowsChunked(
		tx,
		rows.map((row) => row.id),
		{ status: "failed", ...RELEASE_CLAIM, error: "Lease expired after maximum attempts", completedAt: now, updatedAt: now },
	);

	const failedRows = rows.filter((row) => updated.has(row.id));
	await applyOperationCounts(toOperationCounts(failedRows), (operationId, amount) =>
		workerOperationRepository.markJobFinished(operationId, "failed", now, tx, amount),
	);

	await cascadeCancel(
		tx,
		failedRows.map((row) => row.id),
		now,
	);

	return updated.size;
}

/**
 * Shared guarded terminal transition for one running job. The caller owns the
 * status-specific values and after-hook (operation counters / dependent
 * cascade); the `updatedJob ? … : false` result contract lives here.
 */

/** Guarded UPDATE per id chunk (`status = 'running'`), returning the ids actually transitioned. */
async function updateRunningRowsChunked(
	tx: DatabaseTransaction,
	ids: readonly string[],
	values: SQLiteUpdateSetSource<typeof items>,
): Promise<Set<string>> {
	const updated = new Set<string>();
	await forEachChunked(ids, async (chunkIds) => {
		const res = await tx
			.update(items)
			.set(values)
			.where(and(inArray(items.id, chunkIds), eq(items.status, "running")))
			.returning({ id: items.id });
		for (const row of res) updated.add(row.id);
	});

	return updated;
}

async function recoverExpired(workerId: string, now: Date, tx: DatabaseTransaction, excludeActiveIds?: string[]): Promise<void> {
	const conditions = [eq(items.workerId, workerId), eq(items.status, "running"), lt(items.leaseUntil, now)];
	// Jobs still held by this process (abort already fired, handler may hang until
	// the grace timer) must NOT be recovered and re-claimed by a parallel poll —
	// that would execute the task twice.
	if (excludeActiveIds && excludeActiveIds.length > 0) {
		conditions.push(notInArray(items.id, excludeActiveIds));
	}

	const expiredRows = await tx
		.select({ id: items.id, operationId: items.operationId, attempts: items.attempts, maxAttempts: items.maxAttempts })
		.from(items)
		.where(and(...conditions));

	if (expiredRows.length === 0) return;

	await recoverExpiredRows(tx, expiredRows, now);
}
