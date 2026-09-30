import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { users } from "./auth.schema";

/**
 * Machine integration keys. The raw secret is shown once at creation — only the
 * SHA-256 hash lives in the database, so a leaked backup cannot leak keys.
 * `read_only` keys are rejected for every non-GET request at the auth layer.
 */
export const apiKeys = sqliteTable(
	"api_keys",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		keyHash: text("key_hash").notNull(),
		keyPrefix: text("key_prefix").notNull(),
		scope: text("scope").notNull().default("read_only"),
		createdBy: text("created_by")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		expiresAt: integer("expires_at", { mode: "timestamp" }),
		lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("api_keys_hash_unique").on(t.keyHash),
		index("api_keys_created_by_idx").on(t.createdBy),
		check("api_keys_scope_check", sql`${t.scope} IN ('read_only', 'full')`),
	],
);
