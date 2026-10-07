import type { WorkerBackoffType } from "@reelvault/sdk/common";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { forEachChunked, mapChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { MINUTE, serverConstants } from "@/server.constants";
import { chunk, toMap, unique } from "@/utils/array.utils";
import { ConflictError, NotFoundError, ValidationError } from "@/utils/errors";
import { workerJobSummaryColumns } from "./worker-job.projection";
import { workerOperationRepository } from "./worker-operation.repository";

const items = schema.workerJobs;
const operations = schema.workerOperations;

export type WorkerItem = typeof items.$inferSelect;
type WorkerItemStatus = WorkerItem["status"];

/** Minimal projection for "is there an active job for this dedupe key?" checks. */
export type ActiveWorkerItem = Pick<WorkerItem, "id" | "operationId">;

/** Worker-job row without the `data` payload blob, for list/admin reads. */
export type WorkerItemSummary = Omit<WorkerItem, "data">;

/** Clears a running job's claim identically across every terminal/recovery transition. */
const RELEASE_CLAIM = { leaseUntil: null, runnerId: null, claimToken: null } as const;

export interface EnqueueWorkerItemInput {
	id: string;
	workerId: string;
	operationId?: string | undefined;
	dependsOnJobId?: string | undefined;
	dependsOnTaskIds?: string[] | undefined; // Public plural convenience form — only the first id is stored, as dependsOnJobId
	data: string;
	dedupeKey?: string | undefined;
	referenceType?: string | undefined;
	referenceId?: string | undefined;
	priority: number;
	maxAttempts: number;
	backoffType: WorkerBackoffType;
	backoffDelayMs: number;
	runAt: Date;
}

interface ClaimNextInput {
	workerId: string;
	runnerId: string;
	concurrency: number;
	timeoutMs: number;
	now: Date;
	/** Jobs still executed in memory by this process — must never be recovered. */
	excludeActiveIds?: string[] | undefined;
}

export interface WorkerItemStats {
	workerId: string;
	status: WorkerItemStatus;
	count: number;
}

/** WHERE guard for a running-job transition, optionally scoped to a runner and claim token. */
function runningJobWhere(id: string, runnerId?: string, claimToken?: string): SQL | undefined {
	return and(
		eq(items.id, id),
		eq(items.status, "running"),
		...(runnerId ? [eq(items.runnerId, runnerId)] : []),
		...(claimToken ? [eq(items.claimToken, claimToken)] : []),
	);
}

/** Counts rows per non-null `operationId` — the per-operation counter aggregation shared by job transitions. */
function toOperationCounts(rows: ReadonlyArray<{ operationId: string | null }>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (row.operationId) counts.set(row.operationId, (counts.get(row.operationId) ?? 0) + 1);
	}

	return counts;
}

/** Applies one operation-counter mutation per operation, in first-seen order. */
async function applyOperationCounts(
	counts: ReadonlyMap<string, number>,
	apply: (operationId: string, amount: number) => Promise<unknown>,
): Promise<void> {
	for (const [operationId, amount] of counts) {
		await apply(operationId, amount);
	}
}

class WorkerJobRepository {
	async enqueue(input: EnqueueWorkerItemInput): Promise<WorkerItem> {
		const [item] = await this.enqueueMany([input]);
		// Empty result means the dedupe fetch-back found no active row either —
		// the previously-active job went terminal mid-race, so the trigger cannot
		// be satisfied right now (client retries); never a raw 500.
		if (!item) throw new ConflictError(`Failed to enqueue item for worker "${input.workerId}"`);

		return item;
	}

	async enqueueMany(inputs: EnqueueWorkerItemInput[]): Promise<WorkerItem[]> {
		if (inputs.length === 0) return [];

		return await databaseFactory.transaction(
			async (tx) => {
				await this.validateBatchRelations(inputs, tx);

				const values = inputs.map((input) => ({
					id: input.id,
					workerId: input.workerId,
					operationId: input.operationId,
					dependsOnJobId: input.dependsOnJobId ?? input.dependsOnTaskIds?.[0] ?? null,
					data: input.data,
					dedupeKey: input.dedupeKey,
					referenceType: input.referenceType,
					referenceId: input.referenceId,
					priority: input.priority,
					maxAttempts: input.maxAttempts,
					backoffType: input.backoffType,
					backoffDelayMs: input.backoffDelayMs,
					runAt: input.runAt,
				}));

				const insertedItems: WorkerItem[] = [];
				for (const chunkValues of chunk(values, serverConstants.database.queryChunkSize)) {
					const inserted = await tx.insert(items).values(chunkValues).onConflictDoNothing().returning();
					insertedItems.push(...inserted);
				}

				// Only actually-inserted rows count toward the operation total —
				// dedupe fetch-backs were already counted at first enqueue.
				const insertedPerOperation = toOperationCounts(insertedItems);
				await this.fetchDedupedExisting(inputs, insertedItems, tx);

				await applyOperationCounts(insertedPerOperation, (operationId, amount) =>
					workerOperationRepository.incrementTotalItems(operationId, amount, tx),
				);

				return insertedItems;
			},
			{ immediate: true },
		);
	}

	async findItem(id: string, tx?: DatabaseTransaction): Promise<WorkerItem | undefined> {
		const [item] = await databaseFactory.getClient({ tx }).select().from(items).where(eq(items.id, id)).limit(1);

		return item;
	}

	async findActiveByDedupeKey(workerId: string, dedupeKey: string, tx?: DatabaseTransaction): Promise<ActiveWorkerItem | undefined> {
		const [item] = await databaseFactory
			.getClient({ tx })
			.select({ id: items.id, operationId: items.operationId })
			.from(items)
			.where(
				and(eq(items.workerId, workerId), eq(items.dedupeKey, dedupeKey), or(eq(items.status, "pending"), eq(items.status, "running"))),
			)
			.limit(1);

		return item;
	}

	/** Batch variant of {@link findActiveByDedupeKey} — used to validate a bulk enqueue before it inserts anything. */
	async findActiveByWorkerAndDedupeKeys(workerId: string, dedupeKeys: readonly string[]): Promise<ActiveWorkerItem[]> {
		if (dedupeKeys.length === 0) return [];

		return await mapChunked(unique(dedupeKeys), (chunkKeys) =>
			databaseFactory
				.getClient()
				.select({ id: items.id, operationId: items.operationId })
				.from(items)
				.where(and(eq(items.workerId, workerId), inArray(items.dedupeKey, chunkKeys), inArray(items.status, ["pending", "running"]))),
		);
	}

	async listItems(limit = 100, workerId?: string, status?: WorkerItemStatus): Promise<WorkerItemSummary[]> {
		const conditions: SQL[] = [];
		if (workerId) conditions.push(eq(items.workerId, workerId));

		if (status) conditions.push(eq(items.status, status));

		return await databaseFactory
			.getClient()
			.select(workerJobSummaryColumns)
			.from(items)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(desc(items.createdAt))
			.limit(limit);
	}

	async findPendingWorkerIds(now: Date = new Date()): Promise<string[]> {
		const rows = await databaseFactory
			.getClient()
			.selectDistinct({ workerId: items.workerId })
			.from(items)
			.where(and(eq(items.status, "pending"), lte(items.runAt, now)));

		return rows.map((r) => r.workerId);
	}

	/**
	 * Claims every runnable job for one worker in a single transaction, up to
	 * `max` — the sequential `claimNext` re-ran recover/candidates/counts and
	 * fetched-and-discarded the same 20 candidates per claimed job, which made
	 * draining a large enqueue cost ~5 queries per item. Claim semantics are
	 * identical: per-row guarded UPDATE, in-transaction running count, dead
	 * parents cancelled, per-operation counters incremented.
	 */
	async claimNextBatch(input: ClaimNextInput, max: number): Promise<WorkerItem[]> {
		if (max <= 0) return [];

		const { workerId, runnerId, concurrency, timeoutMs, now } = input;
		const [pending] = await databaseFactory
			.getClient()
			.select({ id: items.id })
			.from(items)
			.where(and(eq(items.workerId, workerId), eq(items.status, "pending"), lte(items.runAt, now)))
			.limit(1);
		if (!pending) return [];

		const startedByOperation = new Map<string, number>();

		return await databaseFactory.transaction(async (tx) => {
			await this.recoverExpired(workerId, now, tx, input.excludeActiveIds);

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

			const [runningRow] = await tx
				.select({ count: count() })
				.from(items)
				.where(and(eq(items.workerId, workerId), eq(items.status, "running")));
			let runningCount = runningRow?.count ?? 0;

			const parentStatuses = await this.loadParentStatuses(candidates, tx);

			const claimedItems: WorkerItem[] = [];
			for (const candidate of candidates) {
				if (claimedItems.length >= max) break;

				if (this.isBlockedByDependency(candidate, parentStatuses)) {
					await this.cancelPending(candidate.id, tx);
					continue;
				}

				if (candidate.dependsOnJobId) {
					const parentStatus = parentStatuses.get(candidate.dependsOnJobId);
					if (parentStatus === "pending" || parentStatus === "running") {
						continue; // Prerequisite not finished yet (completed or gone → claimable)
					}
				}

				if (runningCount >= concurrency) break;

				const [claimed] = await tx
					.update(items)
					.set({
						status: "running",
						attempts: sql`${items.attempts} + 1`,
						runnerId,
						claimToken: crypto.randomUUID(),
						leaseUntil: new Date(now.getTime() + timeoutMs),
						startedAt: now,
						updatedAt: now,
					})
					.where(and(eq(items.id, candidate.id), eq(items.status, "pending")))
					.returning();

				if (claimed) {
					// Subsequent claims in this transaction must see the new running row.
					runningCount++;
					if (claimed.operationId) {
						startedByOperation.set(claimed.operationId, (startedByOperation.get(claimed.operationId) ?? 0) + 1);
					}

					claimedItems.push(claimed);
				}
			}

			// One counter update per operation instead of one per claimed job.
			for (const [operationId, amount] of startedByOperation) {
				await workerOperationRepository.markJobStarted(operationId, now, tx, amount);
			}

			return claimedItems;
		});
	}

	/** Batched lookup of dependency-parent statuses for the candidate set. */
	private async loadParentStatuses(
		candidates: Array<{ dependsOnJobId: string | null }>,
		tx: DatabaseTransaction,
	): Promise<Map<string, string>> {
		const parentStatuses = new Map<string, string>();
		const dependencyIds = new Set<string>();
		for (const c of candidates) {
			if (c.dependsOnJobId) dependencyIds.add(c.dependsOnJobId);
		}

		const parentRows = await mapChunked([...dependencyIds], (chunkIds) =>
			tx.select({ id: items.id, status: items.status }).from(items).where(inArray(items.id, chunkIds)),
		);
		for (const parent of parentRows) parentStatuses.set(parent.id, parent.status);

		return parentStatuses;
	}

	/** A candidate whose parent already finished with a terminal failure must be cancelled instead of claimed. */
	private isBlockedByDependency(candidate: { id: string; dependsOnJobId: string | null }, parentStatuses: Map<string, string>): boolean {
		if (!candidate.dependsOnJobId) return false;

		const parentStatus = parentStatuses.get(candidate.dependsOnJobId);

		return parentStatus === "failed" || parentStatus === "cancelled";
	}
	/**
	 * Validates every distinct operation referenced by the batch (mixed batches
	 * would otherwise only validate the first one and desync the other counter)
	 * plus all task dependencies. Batched lookups: a "refresh everything" enqueue
	 * references thousands of items but only a handful of distinct operations.
	 */
	private async validateBatchRelations(inputs: EnqueueWorkerItemInput[], tx: DatabaseTransaction): Promise<void> {
		const operationIds = new Set<string>();
		for (const input of inputs) {
			if (input.operationId) operationIds.add(input.operationId);
		}

		const operationRows = await mapChunked([...operationIds], (chunkIds) =>
			tx
				.select({ id: operations.id, cancelRequested: operations.cancelRequested })
				.from(operations)
				.where(inArray(operations.id, chunkIds)),
		);

		const operationById = toMap(operationRows, (row) => row.id);
		for (const operationId of operationIds) {
			const operation = operationById.get(operationId);
			if (!operation) throw new NotFoundError(`Worker operation not found: ${operationId}`);

			if (operation.cancelRequested) throw new ConflictError(`Worker operation has been cancelled: ${operationId}`);
		}

		const dependencyIds = new Set<string>();
		for (const input of inputs) {
			const depId = input.dependsOnJobId ?? input.dependsOnTaskIds?.[0];
			if (depId) dependencyIds.add(depId);
		}

		const dependencyById = new Map<string, { id: string; operationId: string | null }>();
		const depRows = await mapChunked([...dependencyIds], (chunkIds) =>
			tx.select({ id: items.id, operationId: items.operationId }).from(items).where(inArray(items.id, chunkIds)),
		);
		for (const dep of depRows) dependencyById.set(dep.id, dep);

		for (const input of inputs) {
			const depId = input.dependsOnJobId ?? input.dependsOnTaskIds?.[0];
			if (!depId) continue;

			if (!input.operationId) {
				throw new ValidationError("Worker task dependencies require a non-empty operationId");
			}

			if (depId === input.id) {
				throw new ConflictError("Worker task dependency cannot reference itself");
			}

			const dep = dependencyById.get(depId);
			if (!dep) {
				throw new NotFoundError(`Worker dependency task not found: ${depId}`);
			}

			if (dep.operationId !== input.operationId) {
				throw new ValidationError("Worker task dependencies must belong to the same operation");
			}
		}
	}

	/** Re-attaches already-pending/running rows that lost the dedupe race to the fetch-back. */
	private async fetchDedupedExisting(
		inputs: EnqueueWorkerItemInput[],
		insertedItems: WorkerItem[],
		tx: DatabaseTransaction,
	): Promise<void> {
		if (insertedItems.length >= inputs.length) return;

		const insertedIds = new Set(insertedItems.map((i) => i.id));
		const missingInputs = inputs.filter((input) => input.dedupeKey && !insertedIds.has(input.id));
		if (missingInputs.length === 0) return;

		// Deduplicate (workerId, dedupeKey) pairs so a single chunked query covers
		// every worker in the batch instead of one query per worker group.
		const pairs = new Map<string, { workerId: string; dedupeKey: string }>();
		for (const input of missingInputs) {
			if (!input.dedupeKey) continue;

			pairs.set(`${input.workerId}\u0000${input.dedupeKey}`, { workerId: input.workerId, dedupeKey: input.dedupeKey });
		}

		const existingRows = await mapChunked([...pairs.values()], (chunkPairs) =>
			tx
				.select()
				.from(items)
				.where(
					and(
						inArray(items.status, ["pending", "running"]),
						or(...chunkPairs.map((pair) => and(eq(items.workerId, pair.workerId), eq(items.dedupeKey, pair.dedupeKey)))),
					),
				),
		);
		insertedItems.push(...existingRows);
	}
	async updateProgress(id: string, progressPercent: number, claimToken?: string): Promise<void> {
		await databaseFactory
			.getClient()
			.update(items)
			.set({ progressPercent, updatedAt: new Date() })
			.where(and(eq(items.id, id), ...(claimToken ? [eq(items.claimToken, claimToken)] : [])));
	}

	async complete(id: string, runnerId: string, result: string, claimToken?: string): Promise<boolean> {
		const now = new Date();

		return await databaseFactory.transaction(
			async (tx) =>
				await this.terminalizeRunning(tx, {
					id,
					runnerId,
					claimToken,
					values: {
						status: "completed",
						result,
						error: null,
						...RELEASE_CLAIM,
						progressPercent: 100,
						completedAt: now,
						updatedAt: now,
					},
					afterUpdated: async (updatedJob) => {
						if (updatedJob.operationId) {
							await workerOperationRepository.markJobFinished(updatedJob.operationId, "completed", now, tx);
						}
					},
				}),
		);
	}

	async retry(id: string, runnerId: string, runAt: Date, error: string, claimToken?: string): Promise<boolean> {
		return await databaseFactory.transaction(async (tx) => {
			const updated = await tx
				.update(items)
				.set({
					status: "pending",
					runAt,
					error,
					...RELEASE_CLAIM,
					updatedAt: new Date(),
				})
				.where(runningJobWhere(id, runnerId, claimToken))
				.returning({ id: items.id, operationId: items.operationId });

			const updatedJob = updated[0];
			if (updatedJob?.operationId) {
				await workerOperationRepository.markJobRetried(updatedJob.operationId, new Date(), tx);
			}

			return updatedJob !== undefined;
		});
	}

	async fail(id: string, runnerId: string, error: string, claimToken?: string): Promise<boolean> {
		const now = new Date();

		return await databaseFactory.transaction(
			async (tx) =>
				await this.terminalizeRunning(tx, {
					id,
					runnerId,
					claimToken,
					values: {
						status: "failed",
						error,
						...RELEASE_CLAIM,
						completedAt: now,
						updatedAt: now,
					},
					afterUpdated: async (updatedJob) => {
						if (updatedJob.operationId) {
							await workerOperationRepository.markJobFinished(updatedJob.operationId, "failed", now, tx);
						}

						await this.cascadeCancel(tx, [id], now);
					},
				}),
		);
	}

	async cancelPending(id: string, tx?: DatabaseTransaction): Promise<boolean> {
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
			await this.cascadeCancel(tx, [id], now);
		} else {
			await databaseFactory.transaction(async (innerTx) => {
				await this.cascadeCancel(innerTx, [id], now);
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
	private async cascadeCancel(tx: DatabaseTransaction, parentIds: string[], now: Date): Promise<void> {
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

		await forEachChunked(affected, (chunkRows) =>
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

		await applyOperationCounts(toOperationCounts(affected), (operationId, amount) =>
			workerOperationRepository.markPendingJobsCancelled(operationId, now, tx, amount),
		);
	}

	async cancelRunning(id: string, claimToken?: string): Promise<boolean> {
		const now = new Date();

		return await databaseFactory.transaction(async (tx) => {
			const updated = await tx
				.update(items)
				.set({ status: "cancelled", ...RELEASE_CLAIM, completedAt: now, updatedAt: now })
				.where(runningJobWhere(id, undefined, claimToken))
				.returning({ id: items.id, operationId: items.operationId });

			const updatedJob = updated[0];
			if (updatedJob?.operationId) {
				await workerOperationRepository.markJobFinished(updatedJob.operationId, "cancelled", now, tx);
			}

			return updatedJob !== undefined;
		});
	}

	/** Returns an aborted running task to the queue with its attempt counter preserved (server rescue). */
	async requeueRunning(id: string, runnerId: string, reason: string, claimToken?: string): Promise<boolean> {
		return await this.retry(id, runnerId, new Date(), reason, claimToken);
	}

	async cancelPendingByOperation(operationId: string): Promise<number> {
		const now = new Date();

		return await databaseFactory.transaction(async (tx) => {
			const updated = await tx
				.update(items)
				.set({ status: "cancelled", completedAt: now, updatedAt: now })
				.where(and(eq(items.operationId, operationId), eq(items.status, "pending")))
				.returning({ id: items.id });

			// Cancelled parents must cascade to their dependent children, same as a
			// single cancelPending — one set-based pass instead of a query per row.
			if (updated.length > 0) {
				await this.cascadeCancel(
					tx,
					updated.map((row) => row.id),
					now,
				);
				// Sync the parent operation's counters for the cancelled top-level rows.
				await workerOperationRepository.markPendingJobsCancelled(operationId, now, tx, updated.length);
			}

			return updated.length;
		});
	}

	async findRunningByOperation(operationId: string): Promise<WorkerItem[]> {
		return await databaseFactory
			.getClient()
			.select()
			.from(items)
			.where(and(eq(items.operationId, operationId), eq(items.status, "running")));
	}

	/** Jobs of an operation (newest first) — used to read a single-job operation's result. */
	async findByOperation(operationId: string, limit = 1): Promise<WorkerItem[]> {
		return await databaseFactory
			.getClient()
			.select()
			.from(items)
			.where(eq(items.operationId, operationId))
			.orderBy(desc(items.createdAt))
			.limit(limit);
	}

	/** True while the operation still has a pending/running job (e.g. a queued stream-init). */
	/** Active (pending/running) operation ids among the given set — batch probe for the session reaper. */
	async findActiveOperations(operationIds: readonly string[], tx?: DatabaseTransaction): Promise<Set<string>> {
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
	async findCancelledByOperation(operationId: string, limit = 5000): Promise<WorkerItem[]> {
		return await databaseFactory
			.getClient()
			.select()
			.from(items)
			.where(and(eq(items.operationId, operationId), eq(items.status, "cancelled")))
			.limit(limit);
	}

	async cancelAllPending(workerId?: string): Promise<number> {
		const now = new Date();
		const conditions = [eq(items.status, "pending")];
		if (workerId) conditions.push(eq(items.workerId, workerId));

		return await databaseFactory.transaction(async (tx) => {
			const updated = await tx
				.update(items)
				.set({ status: "cancelled", completedAt: now, updatedAt: now })
				.where(and(...conditions))
				.returning({ id: items.id, operationId: items.operationId });

			if (updated.length === 0) return 0;

			// Dependents of a cancelled parent must not stay pending forever.
			await this.cascadeCancel(
				tx,
				updated.map((row) => row.id),
				now,
			);

			// Keep operation counters in sync, decrementing pendingItems (not runningItems).
			await applyOperationCounts(toOperationCounts(updated), (operationId, amount) =>
				workerOperationRepository.markPendingJobsCancelled(operationId, now, tx, amount),
			);

			return updated.length;
		});
	}

	async cancelAllRunning(workerId?: string): Promise<number> {
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

			const cancelledByOperation = new Map<string, number>();
			for (const row of cancelled) {
				if (!row.operationId) continue;

				cancelledByOperation.set(row.operationId, (cancelledByOperation.get(row.operationId) ?? 0) + 1);
			}

			for (const [operationId, amount] of cancelledByOperation) {
				await workerOperationRepository.markJobFinished(operationId, "cancelled", now, tx, amount);
			}

			return cancelled.length;
		});
	}

	async getStats(): Promise<WorkerItemStats[]> {
		const rows = await databaseFactory
			.getClient()
			.select({
				workerId: items.workerId,
				status: items.status,
				count: count(),
			})
			.from(items)
			.groupBy(items.workerId, items.status);

		return rows.map((r) => ({
			workerId: r.workerId,
			status: r.status,
			count: r.count,
		}));
	}

	async recoverOrphanedRunning(options?: {
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
			const retryable = expiredRows.filter((row) => row.attempts < row.maxAttempts);
			const exhausted = expiredRows.filter((row) => row.attempts >= row.maxAttempts);
			const retriedCount = await this.recoverRetryableRows(tx, retryable, now);
			const failedCount = await this.recoverExhaustedRows(tx, exhausted, now);

			return retriedCount + failedCount;
		});
	}

	/** Requeue selected orphan rows, re-checking `running` so a row that completed in the meantime cannot be resurrected. */
	private async recoverRetryableRows(
		tx: DatabaseTransaction,
		rows: Array<{ id: string; operationId: string | null }>,
		now: Date,
	): Promise<number> {
		const updated = await this.recoverRows(tx, rows, { status: "pending", ...RELEASE_CLAIM, updatedAt: now });

		const recovered = rows.filter((row) => updated.has(row.id));
		await applyOperationCounts(toOperationCounts(recovered), (operationId, amount) =>
			workerOperationRepository.markJobRetried(operationId, now, tx, amount),
		);

		return updated.size;
	}

	/** Fail selected orphan rows that ran out of attempts, re-checking `running` and cascading to dependents. */
	private async recoverExhaustedRows(
		tx: DatabaseTransaction,
		rows: Array<{ id: string; operationId: string | null }>,
		now: Date,
	): Promise<number> {
		const updated = await this.recoverRows(tx, rows, {
			status: "failed",
			...RELEASE_CLAIM,
			error: "Lease expired after maximum attempts",
			completedAt: now,
			updatedAt: now,
		});

		const failedRows = rows.filter((row) => updated.has(row.id));
		await applyOperationCounts(toOperationCounts(failedRows), (operationId, amount) =>
			workerOperationRepository.markJobFinished(operationId, "failed", now, tx, amount),
		);

		await this.cascadeCancel(
			tx,
			failedRows.map((row) => row.id),
			now,
		);

		return updated.size;
	}

	/** Shared prefix of the orphan-recovery transitions: guarded chunked UPDATE over the still-`running` rows. */
	private async recoverRows(
		tx: DatabaseTransaction,
		rows: Array<{ id: string; operationId: string | null }>,
		values: SQLiteUpdateSetSource<typeof items>,
	): Promise<Set<string>> {
		if (rows.length === 0) return new Set();

		return await this.updateRunningRowsChunked(
			tx,
			rows.map((row) => row.id),
			values,
		);
	}

	/**
	 * Shared guarded terminal transition for one running job. The caller owns the
	 * status-specific values and after-hook (operation counters / dependent
	 * cascade); the `updatedJob ? … : false` result contract lives here.
	 */
	private async terminalizeRunning(
		tx: DatabaseTransaction,
		{
			id,
			runnerId,
			claimToken,
			values,
			afterUpdated,
		}: {
			id: string;
			runnerId: string;
			claimToken?: string | undefined;
			values: SQLiteUpdateSetSource<typeof items>;
			afterUpdated: (updatedJob: { operationId: string | null }) => Promise<void>;
		},
	): Promise<boolean> {
		const updated = await tx
			.update(items)
			.set(values)
			.where(runningJobWhere(id, runnerId, claimToken))
			.returning({ id: items.id, operationId: items.operationId });

		const updatedJob = updated[0];
		if (!updatedJob) return false;

		await afterUpdated(updatedJob);

		return true;
	}

	/** Guarded UPDATE per id chunk (`status = 'running'`), returning the ids actually transitioned. */
	private async updateRunningRowsChunked(
		tx: DatabaseTransaction,
		ids: readonly string[],
		values: SQLiteUpdateSetSource<typeof items>,
	): Promise<Set<string>> {
		const updated = new Set<string>();
		for (const chunkIds of chunk([...ids], serverConstants.database.queryChunkSize)) {
			const res = await tx
				.update(items)
				.set(values)
				.where(and(inArray(items.id, chunkIds), eq(items.status, "running")))
				.returning({ id: items.id });
			for (const row of res) updated.add(row.id);
		}

		return updated;
	}

	private async recoverExpired(workerId: string, now: Date, tx: DatabaseTransaction, excludeActiveIds?: string[]): Promise<void> {
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

		const retryable: typeof expiredRows = [];
		const exhausted: typeof expiredRows = [];

		for (const row of expiredRows) {
			(row.attempts >= row.maxAttempts ? exhausted : retryable).push(row);
		}

		await this.recoverRetryableRows(tx, retryable, now);
		await this.recoverExhaustedRows(tx, exhausted, now);
	}

	async trim(workerId: string, status: WorkerItemStatus, keepCount: number): Promise<number> {
		const result = await databaseFactory
			.getClient()
			.delete(items)
			.where(
				sql`${items.id} IN (
				SELECT id FROM ${items}
				WHERE worker_id = ${workerId} AND status = ${status} AND operation_id IS NULL
				ORDER BY completed_at DESC, created_at DESC
				LIMIT -1 OFFSET ${keepCount}
			)`,
			);

		return result.changes;
	}

	/**
	 * Retention trim for many workers in one statement: a per-worker ROW_NUMBER
	 * decides which standalone terminal jobs survive. Replaces the per-worker
	 * DELETE loop in the weekly cleanup (previously up to two DELETEs per
	 * registered worker).
	 */
	async trimMany(status: WorkerItemStatus, keepCounts: ReadonlyMap<string, number>): Promise<number> {
		if (keepCounts.size === 0) return 0;

		const workerIds = [...keepCounts.keys()];
		const keepCase = sql.join(
			workerIds.map((workerId) => sql`WHEN ${workerId} THEN ${keepCounts.get(workerId) ?? 0}`),
			sql` `,
		);
		const result = await databaseFactory
			.getClient()
			.delete(items)
			.where(sql`
			${items.id} IN (
				SELECT id FROM (
					SELECT id, worker_id, ROW_NUMBER() OVER (
						PARTITION BY worker_id ORDER BY completed_at DESC, created_at DESC
					) AS rn
					FROM ${items}
					WHERE ${and(inArray(items.workerId, workerIds), eq(items.status, status), isNull(items.operationId))}
				) WHERE rn > CASE worker_id ${keepCase} ELSE 0 END
			)
		`);

		return result.changes;
	}

	async purgeTerminalJobs(
		options: { status?: "completed" | "failed" | "cancelled" | "all_terminal" | undefined; cutoffDate?: Date | undefined } = {},
	): Promise<number> {
		const statusFilter =
			options.status === "all_terminal" || !options.status
				? inArray(items.status, ["completed", "failed", "cancelled"])
				: eq(items.status, options.status);

		const conditions = [statusFilter];
		if (options.cutoffDate) {
			conditions.push(lt(items.createdAt, options.cutoffDate));
		}

		const where = and(...conditions);
		// `changes` avoids materializing every deleted id (weekly purge can span
		// hundreds of thousands of rows on a busy ingest box).
		const result = await databaseFactory.getClient().delete(items).where(where);

		return result.changes;
	}
}

export const workerJobRepository = new WorkerJobRepository();
