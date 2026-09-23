import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, like, lt, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";
import { serverConfig } from "@/server.config";
import { DAY } from "@/server.constants";
import { chunk } from "@/utils/array.utils";
import { ConflictError } from "@/utils/errors";
import { clamp } from "@/utils/math.utils";
import { isFiniteNumber } from "@/utils/type.utils";
import type { WorkerItemSummary } from "./worker.repository";
import { workerJobSummaryColumns } from "./worker-job.projection";

const operations = schema.workerOperations;
const jobs = schema.workerJobs;

export type WorkerOperationRecord = typeof operations.$inferSelect;

export type WorkerOperationStatus = WorkerOperationRecord["status"];

export interface WorkerOperation extends WorkerOperationRecord {
	etaMs: number | null;
}

interface CreateWorkerOperationInput {
	id: string;
	type: string;
	referenceType?: string | undefined;
	referenceId?: string | undefined;
	error?: string | undefined;
}

class WorkerOperationRepository {
	async create(input: CreateWorkerOperationInput): Promise<WorkerOperationRecord> {
		const [operation] = await databaseFactory
			.getClient()
			.insert(operations)
			.values({
				id: input.id,
				type: input.type,
				referenceType: input.referenceType,
				referenceId: input.referenceId,
				error: input.error,
				status: input.error ? "failed" : "pending",
			})
			.returning();
		if (!operation) throw new ConflictError("Failed to create worker operation");

		return operation;
	}

	async findById(id: string): Promise<WorkerOperation | undefined> {
		const [row] = await databaseFactory.getClient().select().from(operations).where(eq(operations.id, id)).limit(1);

		return row ? this.withEta(row) : undefined;
	}

	async list(
		options: { status?: WorkerOperationStatus | "active" | undefined; limit?: number | undefined; offset?: number | undefined } = {},
	): Promise<{ data: WorkerOperation[]; total: number }> {
		const client = databaseFactory.getClient();
		let whereClause: SQL | undefined;
		if (options.status === "active") {
			whereClause = inArray(operations.status, ["pending", "running"]);
		} else if (options.status) {
			whereClause = eq(operations.status, options.status);
		}

		const [countRows, rows] = await Promise.all([
			client.select({ count: count() }).from(operations).where(whereClause),
			client
				.select()
				.from(operations)
				.where(whereClause)
				.orderBy(desc(operations.createdAt))
				.limit(options.limit ?? 50)
				.offset(options.offset ?? 0),
		]);

		return {
			data: rows.map((r) => this.withEta(r)),
			total: countRows[0]?.count ?? 0,
		};
	}

	async incrementTotalItems(operationId: string, amount: number, tx?: DatabaseTransaction): Promise<void> {
		if (amount <= 0) return;

		await databaseFactory
			.getClient({ tx })
			.update(operations)
			.set({
				totalItems: sql`${operations.totalItems} + ${amount}`,
				pendingItems: sql`${operations.pendingItems} + ${amount}`,
				updatedAt: new Date(),
			})
			.where(eq(operations.id, operationId));
	}

	async updateProgress(operationId: string, progressPercent: number, tx?: DatabaseTransaction): Promise<void> {
		await databaseFactory
			.getClient({ tx })
			.update(operations)
			.set({
				progressPercent: clamp(Math.round(progressPercent), 0, 100),
				updatedAt: new Date(),
			})
			.where(eq(operations.id, operationId));
	}

	async markJobStarted(operationId: string, now: Date = new Date(), tx?: DatabaseTransaction): Promise<void> {
		await databaseFactory
			.getClient({ tx })
			.update(operations)
			.set({
				// UPDATE SET expressions see the pre-update row values in SQLite
				status: sql`CASE WHEN ${operations.status} = 'pending' THEN 'running' ELSE ${operations.status} END`,
				pendingItems: sql`MAX(${operations.pendingItems} - 1, 0)`,
				runningItems: sql`${operations.runningItems} + 1`,
				startedAt: sql`COALESCE(${operations.startedAt}, ${Math.floor(now.getTime() / 1000)})`,
				updatedAt: now,
			})
			.where(eq(operations.id, operationId));
	}

	/**
	 * Keeps a streaming-session operation alive while its ffmpeg process runs,
	 * past the short-lived stream-init job. Called once per session by the
	 * progress monitor (which guards against seek-restart double-counting), so it
	 * always claims a slot here — including while the stream-init job is still
	 * `running`, otherwise that job's completion would terminalize the operation.
	 */
	async markStreamAttached(operationId: string): Promise<void> {
		const now = new Date();
		await databaseFactory
			.getClient()
			.update(operations)
			.set({
				status: "running",
				runningItems: sql`${operations.runningItems} + 1`,
				completedAt: null,
				updatedAt: now,
			})
			.where(eq(operations.id, operationId));
	}

	/** Releases the streaming slot counter — the reaper calls this on session teardown. */
	async releaseStreamSlot(operationId: string): Promise<void> {
		const now = new Date();
		await databaseFactory
			.getClient()
			.update(operations)
			.set({
				runningItems: sql`MAX(${operations.runningItems} - 1, 0)`,
				updatedAt: now,
			})
			.where(eq(operations.id, operationId));
	}

	/**
	 * Closes the slot after a natural ffmpeg EOF: when no other work is pending
	 * the operation terminalizes as completed at 100%. Kills (seek, release) keep
	 * the slot with the session — the reaper finalizes those.
	 */
	async completeStreamSlot(operationId: string): Promise<void> {
		const now = new Date();
		const newRunning = sql`MAX(${operations.runningItems} - 1, 0)`;
		const newFinished = sql`(${operations.completedItems} + ${operations.failedItems} + ${operations.cancelledItems})`;
		const isIdleAndDone = sql`(${newRunning} = 0 AND ${operations.totalItems} > 0 AND ${newFinished} >= ${operations.totalItems})`;
		await databaseFactory
			.getClient()
			.update(operations)
			.set({
				runningItems: newRunning,
				status: sql`CASE WHEN ${isIdleAndDone} THEN 'completed' ELSE ${operations.status} END`,
				completedAt: sql`CASE WHEN ${isIdleAndDone} THEN ${Math.floor(now.getTime() / 1000)} ELSE ${operations.completedAt} END`,
				updatedAt: now,
			})
			.where(eq(operations.id, operationId));
	}

	async markJobRetried(operationId: string, now: Date = new Date(), tx?: DatabaseTransaction, amount = 1): Promise<void> {
		if (amount <= 0) return;

		await databaseFactory
			.getClient({ tx })
			.update(operations)
			.set({
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
			})
			.where(eq(operations.id, operationId));
	}

	async markJobFinished(
		operationId: string,
		jobStatus: "completed" | "failed" | "cancelled",
		_errorMsg?: string,
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

		await databaseFactory
			.getClient({ tx })
			.update(operations)
			.set({
				runningItems: newRunning,
				completedItems: newCompleted,
				failedItems: newFailed,
				cancelledItems: newCancelled,
				// While a live streaming slot holds the operation open, the percent
				// belongs to the transcode progress monitor — a finishing job (the
				// seconds-long stream-init) must not stomp it back to the item ratio.
				progressPercent: sql`CASE
					WHEN ${newRunning} > 0 THEN ${operations.progressPercent}
					WHEN ${operations.totalItems} > 0 THEN CAST(ROUND(${newFinished} * 100.0 / ${operations.totalItems}) AS INTEGER)
					ELSE 100
				END`,
				status: sql`CASE
					WHEN ${operations.status} = 'cancelled' THEN 'cancelled'
					WHEN ${newFinished} >= ${operations.totalItems} AND ${newRunning} = 0 THEN
						CASE
							WHEN ${operations.cancelRequested} OR ${newCancelled} > 0 THEN 'cancelled'
							WHEN ${newFailed} > 0 THEN 'failed'
							ELSE 'completed'
						END
					WHEN ${newRunning} = 0 AND ${operations.totalItems} - ${newFinished} > 0 THEN 'pending'
					WHEN ${newRunning} > 0 THEN 'running'
					ELSE ${operations.status}
				END`,
				completedAt: sql`CASE WHEN ${newFinished} >= ${operations.totalItems} AND ${newRunning} = 0 THEN ${Math.floor(now.getTime() / 1000)} ELSE ${operations.completedAt} END`,
				updatedAt: now,
			})
			.where(eq(operations.id, operationId));
	}

	/**
	 * Cancels `amount` PENDING jobs of an operation. Unlike {@link markJobFinished}
	 * this decrements `pendingItems` (not `runningItems`) — passing a pending count
	 * to markJobFinished corrupted the running counter.
	 */
	async markPendingJobsCancelled(operationId: string, now: Date = new Date(), tx?: DatabaseTransaction, amount = 1): Promise<void> {
		if (amount <= 0) return;

		const remainingPending = sql`MAX(${operations.pendingItems} - ${amount}, 0)`;
		const newCancelled = sql`${operations.cancelledItems} + ${amount}`;
		const newFinished = sql`(${operations.completedItems} + ${operations.failedItems} + ${newCancelled})`;

		await databaseFactory
			.getClient({ tx })
			.update(operations)
			.set({
				pendingItems: remainingPending,
				cancelledItems: newCancelled,
				progressPercent: sql`CASE
					WHEN ${operations.runningItems} > 0 THEN ${operations.progressPercent}
					WHEN ${operations.totalItems} > 0 THEN CAST(ROUND(${newFinished} * 100.0 / ${operations.totalItems}) AS INTEGER)
					ELSE 100
				END`,
				status: sql`CASE
					WHEN ${operations.status} = 'cancelled' THEN 'cancelled'
					WHEN ${newFinished} >= ${operations.totalItems} AND ${operations.runningItems} = 0 THEN 'cancelled'
					WHEN ${operations.runningItems} > 0 THEN 'running'
					ELSE ${operations.status}
				END`,
				completedAt: sql`CASE WHEN ${newFinished} >= ${operations.totalItems} AND ${operations.runningItems} = 0 THEN ${Math.floor(now.getTime() / 1000)} ELSE ${operations.completedAt} END`,
				updatedAt: now,
			})
			.where(eq(operations.id, operationId));
	}

	/** Admin resume: clear the cancel request and re-arm the operation for its re-enqueued jobs. */
	async markResumed(id: string): Promise<void> {
		const now = new Date();
		await databaseFactory
			.getClient()
			.update(operations)
			.set({
				cancelRequested: false,
				status: "pending",
				completedAt: null,
				// Reset counters so the re-enqueue's increments produce correct totals
				// instead of double-counting against the cancelled run.
				totalItems: 0,
				pendingItems: 0,
				runningItems: 0,
				completedItems: 0,
				failedItems: 0,
				cancelledItems: 0,
				progressPercent: 0,
				updatedAt: now,
			})
			.where(eq(operations.id, id));
	}

	async requestCancel(id: string): Promise<void> {
		const now = new Date();
		await databaseFactory
			.getClient()
			.update(operations)
			.set({
				cancelRequested: true,
				status: "cancelled",
				completedAt: now,
				updatedAt: now,
			})
			.where(eq(operations.id, id));
	}

	async listItems(
		operationId: string,
		options: {
			status?: "pending" | "running" | "completed" | "failed" | "cancelled" | undefined;
			search?: string | undefined;
			limit?: number | undefined;
			offset?: number | undefined;
		} = {},
	): Promise<{ items: WorkerItemSummary[]; total: number }> {
		const client = databaseFactory.getClient();
		const conditions = [eq(jobs.operationId, operationId)];
		if (options.status) conditions.push(eq(jobs.status, options.status));

		if (options.search) conditions.push(like(jobs.data, `%${options.search}%`));

		const where = and(...conditions);
		const [countRows, rows] = await Promise.all([
			client.select({ count: count() }).from(jobs).where(where),
			client
				.select(workerJobSummaryColumns)
				.from(jobs)
				.where(where)
				.orderBy(desc(jobs.createdAt))
				.limit(options.limit ?? 50)
				.offset(options.offset ?? 0),
		]);

		return { items: rows, total: countRows[0]?.count ?? 0 };
	}

	async getOperationItemsSummary(operationId: string) {
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

	async remove(id: string): Promise<void> {
		await databaseFactory.getClient().delete(operations).where(eq(operations.id, id));
	}

	async finalizeTerminalOperations(now: Date = new Date(), retentionDays = 7): Promise<number> {
		const retentionUntil = new Date(now.getTime() + retentionDays * DAY);
		const terminalStatuses: WorkerOperationStatus[] = ["completed", "failed", "cancelled"];
		const matching = await databaseFactory
			.getClient()
			.select({ id: operations.id })
			.from(operations)
			.where(and(inArray(operations.status, terminalStatuses), isNull(operations.retentionUntil)));

		if (matching.length === 0) return 0;

		const ids = matching.map((m) => m.id);
		for (const chunkIds of chunk(ids, serverConfig.database.queryChunkSize)) {
			await databaseFactory.getClient().update(operations).set({ retentionUntil, updatedAt: now }).where(inArray(operations.id, chunkIds));
		}

		return ids.length;
	}

	async cleanupExpired(now: Date = new Date()): Promise<number> {
		// Stamp terminal operations with a retention deadline first — without this
		// the cleanup worker only ever saw rows that already had `retentionUntil`
		// (none), so it was a permanent no-op.
		await this.finalizeTerminalOperations(now);

		const expired = await databaseFactory
			.getClient()
			.select({ id: operations.id })
			.from(operations)
			.where(and(isNotNull(operations.retentionUntil), lt(operations.retentionUntil, now)));

		if (expired.length === 0) return 0;

		const ids = expired.map((e) => e.id);

		return await databaseFactory.transaction(async (tx) => {
			for (const chunkIds of chunk(ids, serverConfig.database.queryChunkSize)) {
				await tx.delete(jobs).where(inArray(jobs.operationId, chunkIds));
				await tx.delete(operations).where(inArray(operations.id, chunkIds));
			}

			return ids.length;
		});
	}

	async purgeTerminalOperations(
		options: { status?: "completed" | "failed" | "cancelled" | "all_terminal" | undefined; cutoffDate?: Date | undefined } = {},
	): Promise<{ deletedOperationsCount: number; deletedJobsCount: number }> {
		const statusFilter =
			options.status === "all_terminal" || !options.status
				? inArray(operations.status, ["completed", "failed", "cancelled"])
				: eq(operations.status, options.status);

		const conditions = [statusFilter];
		if (options.cutoffDate) {
			conditions.push(lt(operations.createdAt, options.cutoffDate));
		}

		const where = and(...conditions);
		const pageSize = serverConfig.database.queryChunkSize;
		let deletedOperationsCount = 0;
		let deletedJobsCount = 0;
		let cursor: string | undefined;

		// Keyset-page instead of loading every matching operation id at once; each
		// page's job+operation deletes run in one transaction so a failure cannot
		// leave jobs deleted while their operation survives.
		for (;;) {
			const page = await databaseFactory
				.getClient()
				.select({ id: operations.id })
				.from(operations)
				.where(cursor ? and(where, gt(operations.id, cursor)) : where)
				.orderBy(asc(operations.id))
				.limit(pageSize);
			if (page.length === 0) break;

			const opIds = page.map((row) => row.id);
			const jobsDeleted = await databaseFactory.transaction(async (tx) => {
				const jobsResult = await databaseFactory.getClient({ tx }).delete(jobs).where(inArray(jobs.operationId, opIds));
				await databaseFactory.getClient({ tx }).delete(operations).where(inArray(operations.id, opIds));

				return jobsResult.changes;
			});
			deletedJobsCount += jobsDeleted;
			deletedOperationsCount += opIds.length;

			if (page.length < pageSize) break;

			cursor = opIds[opIds.length - 1];
		}

		return { deletedOperationsCount, deletedJobsCount };
	}

	private withEta(record: WorkerOperationRecord): WorkerOperation {
		return {
			...record,
			etaMs: computeEtaMs(record.completedItems, record.pendingItems, record.startedAt),
		};
	}
}

export const workerOperationRepository = new WorkerOperationRepository();

function computeEtaMs(completedItems: number, pendingItems: number, startedAt: Date | null): number | null {
	if (pendingItems === 0) return 0;

	if (!(completedItems > 0 && startedAt)) return null;

	const elapsed = Date.now() - startedAt.getTime();
	if (elapsed < 1000) return null;

	const rate = completedItems / elapsed;

	return rate > 0 ? Math.round(pendingItems / rate) : null;
}

function toDateField(dateVal: unknown, msVal: unknown): Date | null {
	if (dateVal instanceof Date) return dateVal;

	if (typeof msVal === "number") return new Date(msVal < 10_000_000_000 ? msVal * 1000 : msVal);

	return null;
}

const VALID_OPERATION_STATUSES = new Set<string>(["pending", "running", "completed", "failed", "cancelled"]);

function isWorkerOperationStatus(val: unknown): val is WorkerOperationStatus {
	return typeof val === "string" && VALID_OPERATION_STATUSES.has(val);
}

export function toReadModel(row: Record<string, unknown>): WorkerOperation {
	const num = (key: string, fallback = 0): number => (isFiniteNumber(row[key]) ? row[key] : fallback);

	const startedAt = toDateField(row.startedAt, row.startedAtMs);
	const completedAt = toDateField(row.completedAt, row.completedAtMs);

	const totalItems = num("totalItems");
	const pendingItems = num("pendingItems");
	const runningItems = num("runningItems");
	const completedItems = num("completedItems");
	const failedItems = num("failedItems");
	const cancelledItems = num("cancelledItems");

	const etaMs = computeEtaMs(completedItems, pendingItems, startedAt);
	let status: WorkerOperationStatus = "running";
	if (isWorkerOperationStatus(row.status)) {
		status = row.status;
	} else if (pendingItems === 0 && runningItems === 0) {
		status = "completed";
	}

	let progressPercent: number | null = null;
	if (typeof row.progressPercent === "number") {
		progressPercent = row.progressPercent;
	} else if (totalItems > 0) {
		progressPercent = Math.round((completedItems * 100) / totalItems);
	}

	return {
		id: typeof row.id === "string" ? row.id : "",
		type: typeof row.type === "string" ? row.type : "",
		status,
		cancelRequested: Boolean(row.cancelRequested),
		referenceType: typeof row.referenceType === "string" ? row.referenceType : null,
		referenceId: typeof row.referenceId === "string" ? row.referenceId : null,
		totalItems,
		pendingItems,
		runningItems,
		completedItems,
		failedItems,
		cancelledItems,
		progressPercent,
		etaMs,
		error: typeof row.error === "string" ? row.error : null,
		startedAt,
		completedAt,
		retentionUntil: row.retentionUntil instanceof Date ? row.retentionUntil : null,
		createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(),
		updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(),
	};
}
