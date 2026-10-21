import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, type SQL } from "drizzle-orm";
import { DAY, serverConstants } from "@/config/server/server.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { collectKeysetPages } from "@/integrations/drizzle-orm/query/keyset/keyset-pages.utils";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import type { TerminalRowsPurgeOptions } from "@/workers/worker.ports";
import { jobs, operations, TERMINAL_STATUSES } from "./shared.types";

/** Stamps terminal operations that have no retention deadline yet. Returns how many were stamped. */
export async function finalizeTerminalOperations(now: Date = new Date(), retentionDays = 7): Promise<number> {
	const retentionUntil = new Date(now.getTime() + retentionDays * DAY);
	const matching = await databaseFactory
		.getClient()
		.select({ id: operations.id })
		.from(operations)
		.where(and(inArray(operations.status, TERMINAL_STATUSES), isNull(operations.retentionUntil)));

	if (matching.length === 0) return 0;

	const ids = matching.map((m) => m.id);
	// One transaction for all chunks: a failure midway must not stamp only part
	// of the batch (the sweep would then re-stamp the rest next run anyway, but
	// the read→write window also wants the immediate lock).
	await databaseFactory.transaction(
		async (tx) => {
			await forEachChunked(ids, async (chunkIds) => {
				await tx.update(operations).set({ retentionUntil, updatedAt: now }).where(inArray(operations.id, chunkIds));
			});
		},
		{ immediate: true },
	);

	return ids.length;
}

/** Deletes expired terminal operations and their jobs. Returns how many operations were deleted. */
export async function cleanupExpiredOperations(now: Date = new Date()): Promise<number> {
	// Stamp terminal operations with a retention deadline first — without this
	// the cleanup worker only ever saw rows that already had `retentionUntil`
	// (none), so it was a permanent no-op.
	await finalizeTerminalOperations(now);

	const expired = await databaseFactory
		.getClient()
		.select({ id: operations.id })
		.from(operations)
		// Only terminal operations age out: a resumed (or otherwise live)
		// operation can carry a stale retention deadline and must never lose
		// its row and jobs while pending/running.
		.where(and(isNotNull(operations.retentionUntil), lt(operations.retentionUntil, now), inArray(operations.status, TERMINAL_STATUSES)));

	if (expired.length === 0) return 0;

	const ids = expired.map((e) => e.id);

	return await databaseFactory.transaction(async (tx) => {
		await forEachChunked(ids, async (chunkIds) => {
			await tx.delete(jobs).where(inArray(jobs.operationId, chunkIds));
			await tx.delete(operations).where(inArray(operations.id, chunkIds));
		});

		return ids.length;
	});
}

/** Deletes the terminal operations matching `options`, page by page, with their jobs. */
export async function purgeTerminalOperations(
	options: TerminalRowsPurgeOptions = {},
): Promise<{ deletedOperationsCount: number; deletedJobsCount: number }> {
	const where = terminalOperationsWhere(options);
	const pageSize = serverConstants.database.queryChunkSize;
	let deletedJobsCount = 0;

	// Keyset-page instead of loading every matching operation id at once; each
	// page's job+operation deletes run in one transaction so a failure cannot
	// leave jobs deleted while their operation survives.
	const deletedOperationsCount = await collectKeysetPages({
		pageSize,
		fetchPage: (cursor) =>
			databaseFactory
				.getClient()
				.select({ id: operations.id })
				.from(operations)
				.where(cursor ? and(where, gt(operations.id, cursor)) : where)
				.orderBy(asc(operations.id))
				.limit(pageSize),
		onPage: async (page) => {
			const opIds = page.map((row) => row.id);
			deletedJobsCount += await databaseFactory.transaction(async (tx) => {
				const jobsResult = await databaseFactory.getClient({ tx }).delete(jobs).where(inArray(jobs.operationId, opIds));
				await databaseFactory.getClient({ tx }).delete(operations).where(inArray(operations.id, opIds));

				return jobsResult.changes;
			});
		},
	});

	return { deletedOperationsCount, deletedJobsCount };
}

/** What `purgeTerminalOperations` would delete with the same filters: the operations and the jobs grouped under them. */
export async function countTerminalOperations(
	options: TerminalRowsPurgeOptions = {},
): Promise<{ deletedOperationsCount: number; deletedJobsCount: number }> {
	const where = terminalOperationsWhere(options);
	const client = databaseFactory.getClient();
	const [deletedOperationsCount, deletedJobsCount] = await Promise.all([
		client.$count(operations, where),
		client.$count(jobs, inArray(jobs.operationId, client.select({ id: operations.id }).from(operations).where(where))),
	]);

	return { deletedOperationsCount, deletedJobsCount };
}

function terminalOperationsWhere(options: TerminalRowsPurgeOptions): SQL | undefined {
	const statusFilter =
		options.status === "all_terminal" || !options.status
			? inArray(operations.status, TERMINAL_STATUSES)
			: eq(operations.status, options.status);

	const conditions = [statusFilter];
	if (options.cutoffDate) {
		conditions.push(lt(operations.createdAt, options.cutoffDate));
	}

	return and(...conditions);
}
