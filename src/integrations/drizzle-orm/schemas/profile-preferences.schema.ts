import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tableRef, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { profiles } from "./profiles.schema";

export const profilePreferenceOverrides = sqliteTable(
	"profile_preferences_overrides",
	{
		profileId: tableRef("profile_id", () => profiles.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		value: text("value").notNull(),

		...timestampColumns,
	},
	(table) => [primaryKey({ columns: [table.profileId, table.key] })],
);
