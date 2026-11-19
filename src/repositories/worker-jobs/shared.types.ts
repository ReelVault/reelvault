import type { WorkerBackoffType } from "@reelvault/sdk/common";
import { and, eq, inArray, isNull, lt, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { schema } from "@/integrations/drizzle-orm/database.schema";

export type WorkerItem = typeof schema.workerJobs.$inferSelect;
export type WorkerItemStatus = WorkerItem["status"];
export type WorkerItemSummary = Omit<WorkerItem, "data">;
export type ActiveWorkerItem = Pick<WorkerItem, "id" | "operationId">;

export interface WorkerItemStats {
	workerId: string;
	status: WorkerItemStatus;
	count: number;
}

export interface EnqueueWorkerItemInput {
	id: string;
	workerId: string;
	operationId?: string | undefined;
	dependsOnJobId?: string | undefined;
	dependsOnTaskIds?: string[] | undefined;
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

export interface ClaimNextInput {
	workerId: string;
	runnerId: string;
	concurrency: number;
	timeoutMs: number;
	now: Date;
	excludeActiveIds?: string[] | undefined;
}

/** The terminal states a purge can remove. */
export type TerminalJobStatus = "completed" | "failed" | "cancelled" | "all_terminal";

/** Which terminal rows a purge touches, and the age cutoff. */
export interface TerminalRowsPurgeOptions {
	status?: TerminalJobStatus | undefined;
	cutoffDate?: Date | undefined;
}

export const items = schema.workerJobs;
export const operations = schema.workerOperations;

/** Clears a running job's claim identically across every terminal/recovery transition. */
export const RELEASE_CLAIM = { leaseUntil: null, runnerId: null, claimToken: null } as const;

/** WHERE guard for a running-job transition, optionally scoped to a runner and claim token. */
export function runningJobWhere(id: string, runnerId?: string, claimToken?: string): SQL | undefined {
	return and(
		eq(items.id, id),
		eq(items.status, "running"),
		...(runnerId ? [eq(items.runnerId, runnerId)] : []),
		...(claimToken ? [eq(items.claimToken, claimToken)] : []),
	);
}

/** Counts rows per non-null `operationId` — the per-operation counter aggregation shared by job transitions. */
export function toOperationCounts(rows: ReadonlyArray<{ operationId: string | null }>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (row.operationId) counts.set(row.operationId, (counts.get(row.operationId) ?? 0) + 1);
	}

	return counts;
}

/** Applies one operation-counter mutation per operation, in first-seen order. */
export async function applyOperationCounts(
	counts: ReadonlyMap<string, number>,
	apply: (operationId: string, amount: number) => Promise<unknown>,
): Promise<void> {
	for (const [operationId, amount] of counts) {
		await apply(operationId, amount);
	}
}

/** Statuses a job still holds a run slot or waits for one in. */
export const ACTIVE_JOB_STATUSES = ["pending", "running"] as const;

/** Statuses a job never leaves. */
export const TERMINAL_JOB_STATUSES = ["completed", "failed", "cancelled"] as const;

/** Status condition of a purge: every terminal status, or the one `options` names. */
export function terminalStatusWhere(column: SQLiteColumn, options: TerminalRowsPurgeOptions): SQL {
	return options.status === "all_terminal" || !options.status ? inArray(column, TERMINAL_JOB_STATUSES) : eq(column, options.status);
}

/** Operation-less jobs in a terminal state, optionally older than the cutoff. */
export function terminalStandaloneJobsWhere(options: TerminalRowsPurgeOptions): SQL | undefined {
	const conditions = [terminalStatusWhere(items.status, options), isNull(items.operationId)];
	if (options.cutoffDate) {
		conditions.push(lt(items.createdAt, options.cutoffDate));
	}

	return and(...conditions);
}
