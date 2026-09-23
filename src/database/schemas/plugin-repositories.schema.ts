import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";

/**
 * Catalog repositories a server browses for installable plugins
 * (see the plugin docs → "Publishing to a catalog").
 * `tokenEncrypted` holds an AES-256-GCM payload for private repositories —
 * it is never returned by the API, only its presence (`hasToken`).
 */
export const pluginRepositories = sqliteTable(
	"plugin_repositories",
	{
		id: DatabaseHelper.id,
		name: text("name").notNull(),
		url: text("url").notNull(),
		tokenEncrypted: text("token_encrypted"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),

		lastRefreshedAt: integer("last_refreshed_at", { mode: "timestamp" }),
		lastError: text("last_error"),
		...DatabaseHelper.timestamps,
	},
	(table) => [
		index("plugin_repositories_enabled_idx").on(table.enabled),
		uniqueIndex("plugin_repositories_url_unique").on(table.url),
		check("plugin_repositories_url_check", sql`${table.url} LIKE 'http%'`),
	],
);
