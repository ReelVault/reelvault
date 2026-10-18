import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * UI contributions an administrator switched off. A row means "hidden"; showing
 * a contribution again deletes its row, so the table only ever holds deviations
 * from the default (everything visible). The key `*` hides a plugin's whole UI.
 */
export const pluginUiOverrides = sqliteTable(
	"plugin_ui_overrides",
	{
		pluginId: text("plugin_id").notNull(),
		contributionKey: text("contribution_key").notNull(),
	},
	(t) => [primaryKey({ columns: [t.pluginId, t.contributionKey] })],
);
