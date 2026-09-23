import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";

export const images = sqliteTable(
	"images",
	{
		id: DatabaseHelper.id,
		stableKey: text("stable_key").notNull(),

		localPath: text("local_path").notNull(),
		contentType: text("content_type").notNull(),
		width: integer("width"),
		height: integer("height"),
		fileSize: integer("file_size"),
		optimizationVersion: integer("optimization_version"),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("images_unique").on(t.localPath),
		uniqueIndex("images_stable_key_idx").on(t.stableKey),
		index("images_optimization_version_idx").on(t.optimizationVersion),
		check(
			"images_dimensions_check",
			sql`(${t.width} IS NULL OR ${t.width} > 0)
					AND (${t.height} IS NULL OR ${t.height} > 0)
					AND (${t.fileSize} IS NULL OR ${t.fileSize} >= 0)`,
		),
	],
);
