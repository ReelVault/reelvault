import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { workerOperations } from "./worker-operations.schema";

export const workerJobs = sqliteTable(
	"worker_jobs",
	{
		id: DatabaseHelper.id,

		workerId: text("worker_id").notNull(),
		operationId: DatabaseHelper.nullableTableRef("operation_id", () => workerOperations.id, { onDelete: "set null" }),
		dependsOnJobId: DatabaseHelper.nullableTableRef("depends_on_job_id", (): AnySQLiteColumn => workerJobs.id, { onDelete: "set null" }),
		dedupeKey: text("dedupe_key"),

		referenceType: text("reference_type"),
		referenceId: text("reference_id"),

		data: text("data").notNull(),
		status: text("status", { enum: ["pending", "running", "completed", "failed", "cancelled"] })
			.notNull()
			.default("pending"),
		progressPercent: integer("progress_percent"),

		priority: integer("priority").notNull().default(0),
		attempts: integer("attempts").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull().default(3),
		backoffType: text("backoff_type", { enum: ["fixed", "exponential"] })
			.notNull()
			.default("exponential"),
		backoffDelayMs: integer("backoff_delay_ms").notNull().default(1000),

		leaseUntil: integer("lease_until", { mode: "timestamp" }),
		runnerId: text("runner_id"),
		// Opaque token regenerated on every claim. Terminal/requeue guards match it
		// so a handler that ignored its abort (and was force-released) cannot mutate
		// a row that has since been re-claimed by a newer run.
		claimToken: text("claim_token"),
		result: text("result"),
		error: text("error"),

		startedAt: integer("started_at", { mode: "timestamp" }),
		runAt: integer("run_at", { mode: "timestamp" }).notNull(),
		completedAt: integer("completed_at", { mode: "timestamp" }),
		...DatabaseHelper.timestamps,
	},
	(table) => [
		uniqueIndex("worker_jobs_active_dedupe_unique")
			.on(table.workerId, table.dedupeKey)
			.where(sql`${table.dedupeKey} IS NOT NULL AND ${table.status} IN ('pending', 'running')`),
		index("worker_jobs_claim_idx").on(table.workerId, table.status, table.priority, table.runAt, table.createdAt),
		index("worker_jobs_pending_poll_idx").on(table.status, table.runAt, table.workerId),
		index("worker_jobs_lease_idx").on(table.status, table.leaseUntil),
		// The created_at tiebreaker lets the weekly retention trim walk the index
		// instead of a last-term TEMP B-TREE (ORDER BY completed_at DESC, created_at DESC).
		index("worker_jobs_worker_completed_created_idx").on(table.workerId, table.status, table.completedAt, table.createdAt),
		index("worker_jobs_operation_idx").on(table.operationId, table.status, table.createdAt),
		// Admin/live job lists filter worker+status (or operation) and sort by
		// created_at; the existing composites lead with a column the sort can't use.
		index("worker_jobs_worker_status_created_idx").on(table.workerId, table.status, table.createdAt),
		index("worker_jobs_operation_created_idx").on(table.operationId, table.createdAt),
		index("worker_jobs_status_created_idx").on(table.status, table.createdAt),
		// Orphan/expired recovery only ever scans running rows — a partial index
		// keeps the tiny running set seekable without indexing terminal history.
		index("worker_jobs_running_lease_idx").on(table.leaseUntil).where(sql`${table.status} = 'running'`),
		// cascadeCancel resolves dependents recursively by dependsOnJobId + status
		index("worker_jobs_depends_idx").on(table.dependsOnJobId, table.status),
		// Admin jobs list sorts newest-first across all statuses — without a bare
		// created_at index every page full-scans and temp-sorts the jobs table.
		index("worker_jobs_created_at_idx").on(table.createdAt),
		check("worker_jobs_status_check", sql`${table.status} IN ('pending', 'running', 'completed', 'failed', 'cancelled')`),
		check("worker_jobs_backoff_check", sql`${table.backoffType} IN ('fixed', 'exponential')`),
		check(
			"worker_jobs_values_check",
			sql`${table.attempts} >= 0
					AND ${table.maxAttempts} > 0
					AND ${table.backoffDelayMs} >= 0`,
		),
		check(
			"worker_jobs_reference_check",
			sql`(${table.referenceType} IS NULL AND ${table.referenceId} IS NULL)
					OR (${table.referenceType} IS NOT NULL AND ${table.referenceId} IS NOT NULL)`,
		),
	],
);
