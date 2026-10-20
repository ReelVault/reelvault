import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";

export const systemSettings = sqliteTable("system_settings", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	/** Who saved the current value (null for values set before this column existed, or by no administrator). */
	lastModifiedBy: text("last_modified_by"),

	...timestampColumns,
});
