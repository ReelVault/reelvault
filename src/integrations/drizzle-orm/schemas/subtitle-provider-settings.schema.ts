import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";

/** Admin switch for a registered subtitle provider; a provider without a row is on. */
export const subtitleProviderSettings = sqliteTable("subtitle_provider_settings", {
	providerId: text("provider_id").primaryKey(),
	enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	...timestampColumns,
});
