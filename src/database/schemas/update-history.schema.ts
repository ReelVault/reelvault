import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { users } from "./auth.schema";

/** One install or rollback of the server or the web UI, from the request until its outcome is known. */
export const updateHistory = sqliteTable(
	"update_history",
	{
		id: DatabaseHelper.id,
		actorUserId: DatabaseHelper.nullableTableRef("actor_user_id", () => users.id, { onDelete: "set null" }),

		action: text("action", { enum: ["install", "rollback"] }).notNull(),
		target: text("target", { enum: ["server", "web"] }).notNull(),
		status: text("status", { enum: ["running", "succeeded", "failed", "cancelled"] }).notNull(),

		fromVersion: text("from_version"),
		toVersion: text("to_version").notNull(),
		errorMessage: text("error_message"),

		startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
		finishedAt: integer("finished_at", { mode: "timestamp" }),
	},
	(table) => [index("update_history_started_idx").on(table.startedAt), index("update_history_status_idx").on(table.status)],
);
