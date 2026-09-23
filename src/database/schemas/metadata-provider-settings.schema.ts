import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";

/** Runtime preferences for registered metadata providers, separate from persisted provider entities. */
export const metadataProviderSettings = sqliteTable(
	"metadata_provider_settings",
	{
		providerId: text("provider_id").primaryKey(),
		priority: integer("priority").notNull().default(100),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		...DatabaseHelper.timestamps,
	},
	(table) => [
		index("metadata_provider_settings_priority_idx").on(table.enabled, table.priority, table.providerId),
		// `list()` sorts by (priority, providerId) without an `enabled` predicate.
		index("metadata_provider_settings_order_idx").on(table.priority, table.providerId),
	],
);
