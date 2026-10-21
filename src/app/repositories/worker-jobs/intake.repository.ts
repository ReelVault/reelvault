import { and, desc, eq, inArray, lte, or, type SQL } from "drizzle-orm";
import { readWorkerJobSummaryPage } from "@/app/repositories/worker-job.projection";
import { workerOperationRepository } from "@/app/repositories/worker-operation.repository";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { forEachChunked, mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { findOffsetPage } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { toMap, unique } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import {
	type ActiveWorkerItem,
	applyOperationCounts,
	type EnqueueWorkerItemInput,
	items,
	operations,
	toOperationCounts,
	type WorkerItem,
	type WorkerItemStatus,
	type WorkerItemSummary,
} from "./shared.types";

const jobsAccess = defineTableAccess("workerJobs", { primaryKeyColumn: "id" });

export async function enqueue(input: EnqueueWorkerItemInput): Promise<WorkerItem> {
	const [item] = await enqueueMany([input]);
	// Empty result means the dedupe fetch-back found no active row either —
	// the previously-active job went terminal mid-race, so the trigger cannot
	// be satisfied right now (client retries); never a raw 500.
	if (!item) throw new DomainError("conflict", `Failed to enqueue item for worker "${input.workerId}"`, { code: "worker.enqueue_failed" });

	return item;
}

export async function enqueueMany(
	inputs: EnqueueWorkerItemInput[],
	options: { countOperationTotals?: boolean } = {},
): Promise<WorkerItem[]> {
	if (inputs.length === 0) return [];

	return await databaseFactory.transaction(
		async (tx) => {
			await validateBatchRelations(inputs, tx);

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
			await forEachChunked(values, async (chunkValues) => {
				const inserted = await tx.insert(items).values(chunkValues).onConflictDoNothing().returning();
				insertedItems.push(...inserted);
			});

			// Only actually-inserted rows count toward the operation total —
			// dedupe fetch-backs were already counted at first enqueue. Resume
			// pre-sets the total and passes `countOperationTotals: false`.
			const insertedPerOperation = options.countOperationTotals === false ? null : toOperationCounts(insertedItems);
			await fetchDedupedExisting(inputs, insertedItems, tx);

			if (insertedPerOperation) {
				await applyOperationCounts(insertedPerOperation, (operationId, amount) =>
					workerOperationRepository.incrementTotalItems(operationId, amount, tx),
				);
			}

			return insertedItems;
		},
		{ immediate: true },
	);
}

export async function findItem(id: string, tx?: DatabaseTransaction): Promise<WorkerItem | undefined> {
	const [item] = await databaseFactory.getClient({ tx }).select().from(items).where(eq(items.id, id)).limit(1);

	return item;
}

export async function findActiveByDedupeKey(
	workerId: string,
	dedupeKey: string,
	tx?: DatabaseTransaction,
): Promise<ActiveWorkerItem | undefined> {
	const [item] = await databaseFactory
		.getClient({ tx })
		.select({ id: items.id, operationId: items.operationId })
		.from(items)
		.where(and(eq(items.workerId, workerId), eq(items.dedupeKey, dedupeKey), or(eq(items.status, "pending"), eq(items.status, "running"))))
		.limit(1);

	return item;
}

/** Batch variant of {@link findActiveByDedupeKey} — used to validate a bulk enqueue before it inserts anything. */
export async function findActiveByWorkerAndDedupeKeys(workerId: string, dedupeKeys: readonly string[]): Promise<ActiveWorkerItem[]> {
	if (dedupeKeys.length === 0) return [];

	return await mapChunked(unique(dedupeKeys), (chunkKeys) =>
		databaseFactory
			.getClient()
			.select({ id: items.id, operationId: items.operationId })
			.from(items)
			.where(and(eq(items.workerId, workerId), inArray(items.dedupeKey, chunkKeys), inArray(items.status, ["pending", "running"]))),
	);
}

export async function listItems(options: {
	limit: number;
	offset: number;
	workerId?: string | undefined;
	status?: WorkerItemStatus | undefined;
}): Promise<{ items: WorkerItemSummary[]; total: number }> {
	const conditions: SQL[] = [];
	if (options.workerId) conditions.push(eq(items.workerId, options.workerId));

	if (options.status) conditions.push(eq(items.status, options.status));

	const where = conditions.length > 0 ? and(...conditions) : undefined;
	const { data: rows, total } = await findOffsetPage({
		access: jobsAccess,
		where,
		orderBy: desc(items.createdAt),
		limit: options.limit,
		offset: options.offset,
		findMany: async (page) => await readWorkerJobSummaryPage(databaseFactory.getClient(), page),
		count: () => jobsAccess.count({ where }),
	});

	return { items: rows, total };
}

export async function findPendingWorkerIds(now: Date = new Date()): Promise<string[]> {
	const rows = await databaseFactory
		.getClient()
		.selectDistinct({ workerId: items.workerId })
		.from(items)
		.where(and(eq(items.status, "pending"), lte(items.runAt, now)));

	return rows.map((r) => r.workerId);
}

/** Batched lookup of dependency-parent statuses for the candidate set. */
export async function loadParentStatuses(
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

/**
 * Validates every distinct operation referenced by the batch (mixed batches
 * would otherwise only validate the first one and desync the other counter)
 * plus all task dependencies. Batched lookups: a "refresh everything" enqueue
 * references thousands of items but only a handful of distinct operations.
 */
async function validateBatchRelations(inputs: EnqueueWorkerItemInput[], tx: DatabaseTransaction): Promise<void> {
	const operationIds = new Set<string>();
	for (const input of inputs) {
		if (input.operationId) operationIds.add(input.operationId);
	}

	const operationRows = await mapChunked([...operationIds], (chunkIds) =>
		tx.select({ id: operations.id, cancelRequested: operations.cancelRequested }).from(operations).where(inArray(operations.id, chunkIds)),
	);

	const operationById = toMap(operationRows, (row) => row.id);
	for (const operationId of operationIds) {
		const operation = operationById.get(operationId);
		if (!operation)
			throw new DomainError("not_found", `Worker operation not found: ${operationId}`, { code: "worker.operation_not_found" });

		if (operation.cancelRequested)
			throw new DomainError("conflict", `Worker operation has been cancelled: ${operationId}`, { code: "worker.operation_cancelled" });
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
		assertDependencyValid(input, dependencyById);
	}
}

/** One task's dependency must exist, must not be the task itself, and must share its operation. */
function assertDependencyValid(
	input: EnqueueWorkerItemInput,
	dependencyById: Map<string, { id: string; operationId: string | null }>,
): void {
	const depId = input.dependsOnJobId ?? input.dependsOnTaskIds?.[0];
	if (!depId) return;

	if (!input.operationId) {
		throw new DomainError("validation", "Worker task dependencies require a non-empty operationId", {
			code: "worker.dependency_invalid",
		});
	}

	if (depId === input.id) {
		throw new DomainError("conflict", "Worker task dependency cannot reference itself", { code: "worker.dependency_self" });
	}

	const dep = dependencyById.get(depId);
	if (!dep) {
		throw new DomainError("not_found", `Worker dependency task not found: ${depId}`, { code: "worker.dependency_not_found" });
	}

	if (dep.operationId !== input.operationId) {
		throw new DomainError("validation", "Worker task dependencies must belong to the same operation", {
			code: "worker.dependency_other_operation",
		});
	}
}

/** Re-attaches already-pending/running rows that lost the dedupe race to the fetch-back. */
async function fetchDedupedExisting(inputs: EnqueueWorkerItemInput[], insertedItems: WorkerItem[], tx: DatabaseTransaction): Promise<void> {
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
