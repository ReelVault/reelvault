import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { profiles } from "./profiles.schema";

export const profilePreferenceOverrides = sqliteTable(
	"profile_preferences_overrides",
	{
		profileId: DatabaseHelper.tableRef("profile_id", () => profiles.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		value: text("value").notNull(),

		...DatabaseHelper.timestamps,
	},
	(table) => [primaryKey({ columns: [table.profileId, table.key] })],
);
