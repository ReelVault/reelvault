import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { MemoryCache } from "@/utils/memory.cache";
import {
	items,
	type TerminalRowsPurgeOptions,
	terminalStandaloneJobsWhere,
	type WorkerItemStats,
	type WorkerItemStatus,
} from "./shared.types";

export async function getStats(cache: MemoryCache<WorkerItemStats[]>): Promise<WorkerItemStats[]> {
	return await cache.getOrSet("all", async () => {
		return await databaseFactory
			.getClient()
			.select({
				workerId: items.workerId,
				status: items.status,
				count: count(),
			})
			.from(items)
			.groupBy(items.workerId, items.status);
	});
}

export async function trim(workerId: string, status: WorkerItemStatus, keepCount: number): Promise<number> {
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
export async function trimMany(status: WorkerItemStatus, keepCounts: ReadonlyMap<string, number>): Promise<number> {
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

export async function purgeTerminalJobs(options: TerminalRowsPurgeOptions = {}): Promise<number> {
	// `changes` avoids materializing every deleted id (weekly purge can span
	// hundreds of thousands of rows on a busy ingest box).
	const result = await databaseFactory.getClient().delete(items).where(terminalStandaloneJobsWhere(options));

	return result.changes;
}

/** Rows `purgeTerminalJobs` would delete with the same filters; nothing is removed. */
export async function countTerminalJobs(options: TerminalRowsPurgeOptions = {}): Promise<number> {
	return await databaseFactory.getClient().$count(items, terminalStandaloneJobsWhere(options));
}
