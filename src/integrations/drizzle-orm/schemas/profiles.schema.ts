import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { idColumn, tableRef, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { users } from "./auth.schema";

export const profiles = sqliteTable(
	"profiles",
	{
		id: idColumn,
		userId: tableRef("userId", () => users.id, { onDelete: "cascade" }),

		name: text("name").notNull(),
		avatarUrl: text("avatar_url"),
		pin: text("pin"),

		...timestampColumns,
	},
	(t) => [uniqueIndex("profiles_unique").on(t.name, t.userId), index("profiles_user_idx").on(t.userId)],
);
