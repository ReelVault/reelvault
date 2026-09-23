import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { users } from "./auth.schema";
import { profiles } from "./profiles.schema";

export const notifications = sqliteTable(
	"notifications",
	{
		id: DatabaseHelper.id,
		userId: DatabaseHelper.tableRef("userId", () => users.id, { onDelete: "cascade" }),
		profileId: DatabaseHelper.nullableTableRef("profile_id", () => profiles.id, { onDelete: "cascade" }),

		type: text("type").notNull(),
		title: text("title").notNull(),
		message: text("message"),
		data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
		link: text("link"),
		// Set only by the plugin notification capability — attribution for the
		// per-plugin daily quota; core/system notifications leave it NULL.
		sourcePluginId: text("source_plugin_id"),

		readAt: integer("read_at", { mode: "timestamp" }),
		...DatabaseHelper.timestamps,
	},
	(table) => [
		index("notifications_user_created_idx").on(table.userId, table.createdAt),
		index("notifications_profile_created_idx").on(table.profileId, table.createdAt),
		index("notifications_user_read_idx").on(table.userId, table.readAt),
		index("notifications_plugin_created_idx").on(table.sourcePluginId, table.createdAt),
	],
);
