import type { TaskTrigger } from "@reelvault/sdk/common";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";

export const workerSchedules = sqliteTable("worker_schedules", {
	id: DatabaseHelper.id,
	workerId: text("worker_id").notNull().unique(),
	triggers: text("triggers", { mode: "json" }).$type<TaskTrigger[]>().notNull(),
	isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
	// Persisted deadline — survives restarts, so a daily/weekly run is never
	// lost to downtime (the scheduler fires once per overdue deadline).
	nextRunAt: integer("next_run_at", { mode: "timestamp" }),
	lastRunAt: integer("last_run_at", { mode: "timestamp" }),
	lastCompletedAt: integer("last_completed_at", { mode: "timestamp" }),
	lastStatus: text("last_status", { enum: ["completed", "failed", "cancelled"] }),
	lastDurationMs: integer("last_duration_ms"),
	lastError: text("last_error"),
	...DatabaseHelper.timestamps,
});
