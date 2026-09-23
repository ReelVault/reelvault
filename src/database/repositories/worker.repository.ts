import type { WorkerBackoffType } from "@reelvault/sdk/common";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { forEachChunked, mapChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { serverConfig } from "@/server.config";
import { MINUTE } from "@/server.constants";
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

class WorkerJobRepository {
	async enqueue(input: EnqueueWorkerItemInput): Promise<WorkerItem> {
		const [item] = await this.enqueueMany([input]);
		if (!item) throw new Error(`Failed to enqueue item for worker "${input.workerId}"`);

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
				const insertedPerOperation = new Map<string, number>();
				for (const chunkValues of chunk(values, serverConfig.database.queryChunkSize)) {
					const inserted = await tx.insert(items).values(chunkValues).onConflictDoNothing().returning();
					insertedItems.push(...inserted);
					// Only actually-inserted rows count toward the operation total —
					// dedupe fetch-backs were already counted at first enqueue.
					for (const row of inserted) {
						if (row.operationId) {
							const prev = insertedPerOperation.get(row.operationId) ?? 0;
							insertedPerOperation.set(row.operationId, prev + 1);
						}
					}
				}

				await this.fetchDedupedExisting(inputs, insertedItems, tx);

				// Update operation counters per operation — only for actually-inserted rows.
				for (const [operationId, amount] of insertedPerOperation) {
					await workerOperationRepository.incrementTotalItems(operationId, amount, tx);
				}

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

	async findActiveByWorkerAndDedupe(workerId: string, dedupeKey: string): Promise<ActiveWorkerItem | undefined> {
		return await this.findActiveByDedupeKey(workerId, dedupeKey);
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
						await workerOperationRepository.markJobStarted(claimed.operationId, now, tx);
					}

					claimedItems.push(claimed);
				}
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

		return await databaseFactory.transaction(async (tx) => {
			const updated = await tx
				.update(items)
				.set({
					status: "completed",
					result,
					error: null,
					leaseUntil: null,
					runnerId: null,
					claimToken: null,
					progressPercent: 100,
					completedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(items.id, id),
						eq(items.status, "running"),
						eq(items.runnerId, runnerId),
						...(claimToken ? [eq(items.claimToken, claimToken)] : []),
					),
				)
				.returning({ id: items.id, operationId: items.operationId });

			const updatedJob = updated[0];
			if (updatedJob) {
				if (updatedJob.operationId) {
					await workerOperationRepository.markJobFinished(updatedJob.operationId, "completed", undefined, now, tx);
				}

				return true;
			}

			return false;
		});
	}

	async retry(id: string, runnerId: string, runAt: Date, error: string, claimToken?: string): Promise<boolean> {
		return await databaseFactory.transaction(async (tx) => {
			const updated = await tx
				.update(items)
				.set({
					status: "pending",
					runAt,
					error,
					leaseUntil: null,
					runnerId: null,
					claimToken: null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(items.id, id),
						eq(items.status, "running"),
						eq(items.runnerId, runnerId),
						...(claimToken ? [eq(items.claimToken, claimToken)] : []),
					),
				)
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

		return await databaseFactory.transaction(async (tx) => {
			const updated = await tx
				.update(items)
				.set({
					status: "failed",
					error,
					leaseUntil: null,
					runnerId: null,
					claimToken: null,
					completedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(items.id, id),
						eq(items.status, "running"),
						eq(items.runnerId, runnerId),
						...(claimToken ? [eq(items.claimToken, claimToken)] : []),
					),
				)
				.returning({ id: items.id, operationId: items.operationId });

			const updatedJob = updated[0];
			if (updatedJob) {
				if (updatedJob.operationId) {
					await workerOperationRepository.markJobFinished(updatedJob.operationId, "failed", error, now, tx);
				}

				await this.cascadeCancel(tx, [id], now);

				return true;
			}

			return false;
		});
	}

	async cancelPending(id: string, tx?: DatabaseTransaction): Promise<boolean> {
		const client = databaseFactory.getClient({ tx });
		const [item] = await client.select({ operationId: items.operationId }).from(items).where(eq(items.id, id)).limit(1);
		if (!item) return false;

		const now = new Date();
		const updated = await client
			.update(items)
			.set({ status: "cancelled", completedAt: now, updatedAt: now })
			.where(and(eq(items.id, id), eq(items.status, "pending")))
			.returning({ id: items.id });

		if (updated.length === 1) {
			if (item.operationId) {
				await workerOperationRepository.markPendingJobsCancelled(item.operationId, now, tx, 1);
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

		return false;
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

		const perOperation = new Map<string, number>();
		for (const row of affected) {
			if (row.operationId) perOperation.set(row.operationId, (perOperation.get(row.operationId) ?? 0) + 1);
		}

		for (const [operationId, amount] of perOperation) {
			await workerOperationRepository.markPendingJobsCancelled(operationId, now, tx, amount);
		}
	}

	async cancelRunning(id: string, claimToken?: string): Promise<boolean> {
		const now = new Date();

		const updated = await databaseFactory
			.getClient()
			.update(items)
			.set({ status: "cancelled", leaseUntil: null, runnerId: null, claimToken: null, completedAt: now, updatedAt: now })
			.where(and(eq(items.id, id), eq(items.status, "running"), ...(claimToken ? [eq(items.claimToken, claimToken)] : [])))
			.returning({ id: items.id, operationId: items.operationId });

		const updatedJob = updated[0];
		if (updatedJob?.operationId) {
			await workerOperationRepository.markJobFinished(updatedJob.operationId, "cancelled", undefined, now);
		}

		return updatedJob !== undefined;
	}

	/** Returns an aborted running task to the queue with its attempt counter preserved (server rescue). */
	async requeueRunning(id: string, runnerId: string, reason: string, claimToken?: string): Promise<boolean> {
		return await databaseFactory.transaction(async (tx) => {
			const updated = await tx
				.update(items)
				.set({
					status: "pending",
					runAt: new Date(),
					error: reason,
					leaseUntil: null,
					runnerId: null,
					claimToken: null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(items.id, id),
						eq(items.status, "running"),
						eq(items.runnerId, runnerId),
						...(claimToken ? [eq(items.claimToken, claimToken)] : []),
					),
				)
				.returning({ id: items.id, operationId: items.operationId });

			const updatedJob = updated[0];
			if (updatedJob?.operationId) {
				await workerOperationRepository.markJobRetried(updatedJob.operationId, new Date(), tx);
			}

			return updatedJob !== undefined;
		});
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
	async hasActiveJobForOperation(operationId: string, tx?: DatabaseTransaction): Promise<boolean> {
		const [row] = await databaseFactory
			.getClient({ tx })
			.select({ id: items.id })
			.from(items)
			.where(and(eq(items.operationId, operationId), inArray(items.status, ["pending", "running"])))
			.limit(1);

		return row !== undefined;
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
			const perOperation = new Map<string, number>();
			for (const row of updated) {
				if (row.operationId) perOperation.set(row.operationId, (perOperation.get(row.operationId) ?? 0) + 1);
			}

			for (const [operationId, amount] of perOperation) {
				await workerOperationRepository.markPendingJobsCancelled(operationId, now, tx, amount);
			}

			return updated.length;
		});
	}

	async cancelAllRunning(workerId?: string): Promise<number> {
		const now = new Date();
		const conditions = [eq(items.status, "running")];
		if (workerId) conditions.push(eq(items.workerId, workerId));

		const runningByOperation = await databaseFactory
			.getClient()
			.select({ operationId: items.operationId, count: count() })
			.from(items)
			.where(and(...conditions))
			.groupBy(items.operationId);

		if (runningByOperation.length === 0) return 0;

		const runningCount = runningByOperation.reduce((total, row) => total + row.count, 0);

		await databaseFactory
			.getClient()
			.update(items)
			.set({ status: "cancelled", leaseUntil: null, runnerId: null, claimToken: null, completedAt: now, updatedAt: now })
			.where(and(...conditions));

		for (const item of runningByOperation) {
			if (item.operationId) {
				await workerOperationRepository.markJobFinished(item.operationId, "cancelled", undefined, now, undefined, item.count);
			}
		}

		return runningCount;
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
		if (rows.length === 0) return 0;

		const updated = new Set<string>();
		for (const chunkIds of chunk(
			rows.map((row) => row.id),
			serverConfig.database.queryChunkSize,
		)) {
			const res = await tx
				.update(items)
				.set({ status: "pending", leaseUntil: null, runnerId: null, claimToken: null, updatedAt: now })
				.where(and(inArray(items.id, chunkIds), eq(items.status, "running")))
				.returning({ id: items.id });
			for (const row of res) updated.add(row.id);
		}

		const perOperation = new Map<string, number>();
		for (const row of rows) {
			if (row.operationId && updated.has(row.id)) {
				perOperation.set(row.operationId, (perOperation.get(row.operationId) ?? 0) + 1);
			}
		}

		for (const [operationId, amount] of perOperation) {
			await workerOperationRepository.markJobRetried(operationId, now, tx, amount);
		}

		return updated.size;
	}

	/** Fail selected orphan rows that ran out of attempts, re-checking `running` and cascading to dependents. */
	private async recoverExhaustedRows(
		tx: DatabaseTransaction,
		rows: Array<{ id: string; operationId: string | null }>,
		now: Date,
	): Promise<number> {
		if (rows.length === 0) return 0;

		const updated = new Set<string>();
		for (const chunkIds of chunk(
			rows.map((row) => row.id),
			serverConfig.database.queryChunkSize,
		)) {
			const res = await tx
				.update(items)
				.set({
					status: "failed",
					leaseUntil: null,
					runnerId: null,
					claimToken: null,
					error: "Lease expired after maximum attempts",
					completedAt: now,
					updatedAt: now,
				})
				.where(and(inArray(items.id, chunkIds), eq(items.status, "running")))
				.returning({ id: items.id });
			for (const row of res) updated.add(row.id);
		}

		const cascadableIds: string[] = [];
		const perOperation = new Map<string, number>();
		for (const row of rows) {
			if (!updated.has(row.id)) continue;

			cascadableIds.push(row.id);
			if (row.operationId) perOperation.set(row.operationId, (perOperation.get(row.operationId) ?? 0) + 1);
		}

		for (const [operationId, amount] of perOperation) {
			await workerOperationRepository.markJobFinished(operationId, "failed", "Lease expired", now, tx, amount);
		}

		await this.cascadeCancel(tx, cascadableIds, now);

		return updated.size;
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

		if (retryable.length > 0) {
			const retryIds = retryable.map((r) => r.id);
			await tx
				.update(items)
				.set({ status: "pending", leaseUntil: null, runnerId: null, claimToken: null, updatedAt: now })
				.where(inArray(items.id, retryIds));

			const retryPerOperation = new Map<string, number>();
			for (const row of retryable) {
				if (row.operationId) retryPerOperation.set(row.operationId, (retryPerOperation.get(row.operationId) ?? 0) + 1);
			}

			for (const [operationId, amount] of retryPerOperation) {
				await workerOperationRepository.markJobRetried(operationId, now, tx, amount);
			}
		}

		if (exhausted.length > 0) {
			const failIds = exhausted.map((r) => r.id);
			await tx
				.update(items)
				.set({
					status: "failed",
					leaseUntil: null,
					runnerId: null,
					claimToken: null,
					error: "Lease expired after maximum attempts",
					completedAt: now,
					updatedAt: now,
				})
				.where(inArray(items.id, failIds));

			const exhaustedPerOperation = new Map<string, number>();
			for (const row of exhausted) {
				if (row.operationId) exhaustedPerOperation.set(row.operationId, (exhaustedPerOperation.get(row.operationId) ?? 0) + 1);
			}

			for (const [operationId, amount] of exhaustedPerOperation) {
				await workerOperationRepository.markJobFinished(operationId, "failed", "Lease expired", now, tx, amount);
			}

			await this.cascadeCancel(
				tx,
				exhausted.map((row) => row.id),
				now,
			);
		}
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
