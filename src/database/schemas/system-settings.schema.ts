import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";

export const systemSettings = sqliteTable("system_settings", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),

	...DatabaseHelper.timestamps,
});
