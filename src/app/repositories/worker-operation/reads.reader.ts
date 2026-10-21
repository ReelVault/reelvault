import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { WorkerItemSummary } from "@/app/repositories/worker.repository";
import { readWorkerJobSummaryPage } from "@/app/repositories/worker-job.projection";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { filterLike } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import { mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { findOffsetPage } from "@/integrations/drizzle-orm/query/table-access/reads.reader";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { unique } from "@/utils/array.utils";
import {
	ACTIVE_STATUSES,
	jobs,
	operations,
	type WorkerOperation,
	type WorkerOperationRecord,
	type WorkerOperationStatus,
} from "./shared.types";

const operationsAccess = defineTableAccess("workerOperations", { primaryKeyColumn: "id" });
const jobsAccess = defineTableAccess("workerJobs", { primaryKeyColumn: "id" });

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

	const { data: rows, total } = await findOffsetPage({
		access: operationsAccess,
		where: whereClause,
		orderBy: desc(operations.createdAt),
		limit: options.limit ?? 50,
		offset: options.offset ?? 0,
		countKey: { status: options.status ?? null },
		findMany: async (page) =>
			await client.select().from(operations).where(page.where).orderBy(page.orderBy).limit(page.limit).offset(page.offset),
		count: () => operationsAccess.count({ where: whereClause }),
	});

	return {
		data: rows.map((row) => withEta(row)),
		total,
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

	if (options.search) conditions.push(filterLike(jobs.data, options.search));

	const where = and(...conditions);
	const { data: rows, total } = await findOffsetPage({
		access: jobsAccess,
		where,
		orderBy: desc(jobs.createdAt),
		limit: options.limit ?? 50,
		offset: options.offset ?? 0,
		findMany: async (page) => await readWorkerJobSummaryPage(client, page),
		count: () => jobsAccess.count({ where }),
	});

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
