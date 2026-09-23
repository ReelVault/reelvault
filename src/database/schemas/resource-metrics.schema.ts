import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";

export const resourceMetrics = sqliteTable(
	"resource_metrics",
	{
		id: DatabaseHelper.id,

		// CPU
		cpuUsedPercent: real("cpu_used_percent").notNull(),
		cpuLoadAvg1: real("cpu_load_avg_1").notNull(),
		cpuLoadAvg5: real("cpu_load_avg_5").notNull(),
		cpuLoadAvg15: real("cpu_load_avg_15").notNull(),

		// Memory
		memoryUsedMb: integer("memory_used_mb").notNull(),
		memoryTotalMb: integer("memory_total_mb").notNull(),
		memoryPercent: real("memory_percent").notNull(),

		// Disk
		diskUsedGb: real("disk_used_gb").notNull(),
		diskTotalGb: real("disk_total_gb").notNull(),
		diskPercent: real("disk_percent").notNull(),

		// System
		pressure: text("pressure").notNull(),
		activeStreams: integer("active_streams").notNull().default(0),
		activeWorkers: text("active_workers", { mode: "json" }).$type<Record<string, number>>().notNull(),

		// Retention
		retentionUntil: integer("retention_until", { mode: "timestamp" }).notNull(),

		...DatabaseHelper.timestamps,
	},
	(table) => [
		index("resource_metrics_retention_idx").on(table.retentionUntil),
		index("resource_metrics_timestamp_idx").on(table.createdAt),
		index("resource_metrics_pressure_idx").on(table.pressure),
	],
);
