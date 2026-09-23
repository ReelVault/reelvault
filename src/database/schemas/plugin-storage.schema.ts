import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";

export const pluginStorage = sqliteTable(
	"plugin_storage",
	{
		pluginId: text("plugin_id").notNull(),
		key: text("data_key").notNull(),
		value: text("value").notNull(),

		...DatabaseHelper.timestamps,
	},
	(table) => [primaryKey({ columns: [table.pluginId, table.key] })],
);

export const pluginBlobs = sqliteTable(
	"plugin_blobs",
	{
		pluginId: text("plugin_id").notNull(),

		key: text("data_key").notNull(),
		storageKey: text("storage_key").notNull().unique(),
		contentType: text("content_type").notNull(),
		size: integer("size").notNull(),

		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		...DatabaseHelper.timestamps,
	},
	(table) => [
		primaryKey({ columns: [table.pluginId, table.key] }),
		index("plugin_blobs_expires_idx").on(table.expiresAt),
		check("plugin_blobs_size_check", sql`${table.size} >= 0`),
	],
);
