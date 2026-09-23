import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { users } from "./auth.schema";

export const profiles = sqliteTable(
	"profiles",
	{
		id: DatabaseHelper.id,
		userId: DatabaseHelper.tableRef("userId", () => users.id, { onDelete: "cascade" }),

		name: text("name").notNull(),
		avatarUrl: text("avatar_url"),
		pin: text("pin"),

		...DatabaseHelper.timestamps,
	},
	(t) => [uniqueIndex("profiles_unique").on(t.name, t.userId), index("profiles_user_idx").on(t.userId)],
);
