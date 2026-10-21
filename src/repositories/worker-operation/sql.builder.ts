import { type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { operations } from "./shared.types";

/**
 * Item-ratio progress percent, frozen while `running` holds a live slot (the
 * transcode progress monitor owns the percent then).
 */
export function buildProgressPercentCase(running: SQL | SQLiteColumn, newFinished: SQL): SQL {
	return sql`CASE
					WHEN ${running} > 0 THEN ${operations.progressPercent}
					WHEN ${operations.totalItems} > 0 THEN CAST(ROUND(${newFinished} * 100.0 / ${operations.totalItems}) AS INTEGER)
					ELSE 100
				END`;
}

/**
 * Status CASE frame shared by the job-finishing writers: a cancelled operation
 * stays cancelled, `branches` decides the finished/pending cases and a live
 * running slot keeps the operation running.
 */
export function buildStatusCase(running: SQL | SQLiteColumn, branches: SQL): SQL {
	return sql`CASE
					WHEN ${operations.status} = 'cancelled' THEN 'cancelled'
					${branches}
					WHEN ${running} > 0 THEN 'running'
					ELSE ${operations.status}
				END`;
}

/** Stamps `now` once the operation is finished and idle, otherwise keeps `completedAt`. */
export function buildCompletedAtCase(running: SQL | SQLiteColumn, newFinished: SQL, now: Date): SQL {
	return sql`CASE WHEN ${newFinished} >= ${operations.totalItems} AND ${running} = 0 THEN ${Math.floor(now.getTime() / 1000)} ELSE ${operations.completedAt} END`;
}
