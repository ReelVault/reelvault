import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";

export const workerOperations = sqliteTable(
	"worker_operations",
	{
		id: DatabaseHelper.id,
		type: text("type").notNull(),
		status: text("status", { enum: ["pending", "running", "completed", "failed", "cancelled"] })
			.notNull()
			.default("pending"),
		referenceType: text("reference_type"),
		referenceId: text("reference_id"),
		cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
		totalItems: integer("total_items").notNull().default(0),
		pendingItems: integer("pending_items").notNull().default(0),
		runningItems: integer("running_items").notNull().default(0),
		completedItems: integer("completed_items").notNull().default(0),
		failedItems: integer("failed_items").notNull().default(0),
		cancelledItems: integer("cancelled_items").notNull().default(0),
		progressPercent: integer("progress_percent"),
		error: text("error"),
		startedAt: integer("started_at", { mode: "timestamp" }),
		completedAt: integer("completed_at", { mode: "timestamp" }),
		retentionUntil: integer("retention_until", { mode: "timestamp" }),
		...DatabaseHelper.timestamps,
	},
	(table) => [
		index("worker_operations_status_idx").on(table.status),
		index("worker_operations_status_created_idx").on(table.status, table.createdAt),
		index("worker_operations_type_status_idx").on(table.type, table.status),
		index("worker_operations_reference_idx").on(table.referenceType, table.referenceId),
		index("worker_operations_retention_idx").on(table.retentionUntil),
	],
);
