import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { WorkerItemSummary } from "@/app/repositories/worker.repository";
import { workerJobSummaryColumns } from "@/app/repositories/worker-job.projection";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { QueryFiltering } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import { mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { cachedCount } from "@/integrations/drizzle-orm/query/table-access/row-count.cache";
import { unique } from "@/utils/array.utils";
import {
	ACTIVE_STATUSES,
	jobs,
	operations,
	type WorkerOperation,
	type WorkerOperationRecord,
	type WorkerOperationStatus,
} from "./shared.types";

/** Time left at the observed rate, or null until there is enough progress to estimate. */
function computeEtaMs(completedItems: number, pendingItems: number, startedAt: Date | null): number | null {
	if (pendingItems === 0) return 0;

	if (!(completedItems > 0 && startedAt)) return null;

	const elapsed = Date.now() - startedAt.getTime();
	if (elapsed < 1000) return null;

	const rate = completedItems / elapsed;

	return rate > 0 ? Math.round(pendingItems / rate) : null;
}

export function withEta(record: WorkerOperationRecord): WorkerOperation {
	return {
		...record,
		etaMs: computeEtaMs(record.completedItems, record.pendingItems, record.startedAt),
	};
}

export async function findOperationById(id: string): Promise<WorkerOperation | undefined> {
	const [row] = await databaseFactory.getClient().select().from(operations).where(eq(operations.id, id)).limit(1);

	return row ? withEta(row) : undefined;
}

/** Newest non-terminal operation of a type attached to a reference — used to join an in-flight batch. */
export async function findActiveOperationByReference(
	type: string,
	referenceType: string,
	referenceId: string,
): Promise<WorkerOperationRecord | undefined> {
	const [row] = await databaseFactory
		.getClient()
		.select()
		.from(operations)
		.where(
			and(
				eq(operations.type, type),
				eq(operations.referenceType, referenceType),
				eq(operations.referenceId, referenceId),
				inArray(operations.status, ACTIVE_STATUSES),
				eq(operations.cancelRequested, false),
			),
		)
		.orderBy(desc(operations.createdAt), desc(operations.id))
		.limit(1);

	return row;
}

/**
 * Latest library-scan operation time per library. The periodic rescan reads
 * this as its "last scanned" clock: the timestamp survives restarts, and any
 * manual/watcher scan of a library counts as a recent scan for it.
 */
export async function findLatestLibraryScanTimes(libraryIds: readonly string[]): Promise<Map<string, Date>> {
	if (libraryIds.length === 0) return new Map();

	const rows = await mapChunked(unique(libraryIds), (chunkIds) =>
		databaseFactory
			.getClient()
			.select({ referenceId: operations.referenceId, latest: sql<number>`max(${operations.createdAt})`.mapWith(Number) })
			.from(operations)
			.where(and(eq(operations.type, "library-scanning"), inArray(operations.referenceId, chunkIds)))
			.groupBy(operations.referenceId),
	);

	const result = new Map<string, Date>();
	for (const row of rows) {
		// `mode: "timestamp"` columns store Unix seconds.
		if (row.referenceId) result.set(row.referenceId, new Date(row.latest * 1000));
	}

	return result;
}

export interface ActiveLibraryScan {
	libraryId: string;
	status: "pending" | "running";
	progressPercent: number | null;
}

/** Queued and running library scans, newest first, with the progress each has reported. */
export async function findActiveLibraryScans(): Promise<ActiveLibraryScan[]> {
	const rows = await databaseFactory
		.getClient()
		.select({ referenceId: operations.referenceId, status: operations.status, progressPercent: operations.progressPercent })
		.from(operations)
		.where(and(eq(operations.type, "library-scanning"), inArray(operations.status, ACTIVE_STATUSES)))
		.orderBy(desc(operations.createdAt));

	const scans: ActiveLibraryScan[] = [];
	for (const row of rows) {
		if (!row.referenceId || (row.status !== "pending" && row.status !== "running")) continue;

		scans.push({ libraryId: row.referenceId, status: row.status, progressPercent: row.progressPercent });
	}

	return scans;
}

export interface OperationListOptions {
	status?: WorkerOperationStatus | "active" | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
}

export async function listOperations(options: OperationListOptions = {}): Promise<{ data: WorkerOperation[]; total: number }> {
	const client = databaseFactory.getClient();
	let whereClause: SQL | undefined;
	if (options.status === "active") {
		whereClause = inArray(operations.status, ACTIVE_STATUSES);
	} else if (options.status) {
		whereClause = eq(operations.status, options.status);
	}

	const [countRows, rows] = await Promise.all([
		cachedCount("worker_operations", { status: options.status ?? null }, async () => await client.$count(operations, whereClause)),
		client
			.select()
			.from(operations)
			.where(whereClause)
			// created_at has second resolution — the id tiebreaker keeps offset
			// pagination stable across same-second operations.
			.orderBy(desc(operations.createdAt), desc(operations.id))
			.limit(options.limit ?? 50)
			.offset(options.offset ?? 0),
	]);

	return {
		data: rows.map((row) => withEta(row)),
		total: countRows,
	};
}

export interface OperationItemsOptions {
	status?: "pending" | "running" | "completed" | "failed" | "cancelled" | undefined;
	search?: string | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
}

export async function listOperationItems(
	operationId: string,
	options: OperationItemsOptions = {},
): Promise<{ items: WorkerItemSummary[]; total: number }> {
	const client = databaseFactory.getClient();
	const conditions = [eq(jobs.operationId, operationId)];
	if (options.status) conditions.push(eq(jobs.status, options.status));

	if (options.search) conditions.push(QueryFiltering.like(jobs.data, options.search));

	const where = and(...conditions);
	const [total, rows] = await Promise.all([
		client.$count(jobs, where),
		client
			.select(workerJobSummaryColumns)
			.from(jobs)
			.where(where)
			.orderBy(desc(jobs.createdAt), desc(jobs.id))
			.limit(options.limit ?? 50)
			.offset(options.offset ?? 0),
	]);

	return { items: rows, total };
}

export async function getOperationItemsSummary(operationId: string) {
	const [row] = await databaseFactory
		.getClient()
		.select({
			total: operations.totalItems,
			pending: operations.pendingItems,
			running: operations.runningItems,
			completed: operations.completedItems,
			failed: operations.failedItems,
			cancelled: operations.cancelledItems,
		})
		.from(operations)
		.where(eq(operations.id, operationId))
		.limit(1);

	return row ?? { total: 0, pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
}
