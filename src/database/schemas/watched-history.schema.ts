import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { mediaFiles } from "./media-files.schema";
import { profiles } from "./profiles.schema";

export const watchedHistory = sqliteTable(
	"watched_history",
	{
		id: DatabaseHelper.id,
		mediaFileId: DatabaseHelper.tableRef("media_file_id", () => mediaFiles.id, { onDelete: "cascade" }),
		profileId: DatabaseHelper.tableRef("profile_id", () => profiles.id, { onDelete: "cascade" }),

		durationWatched: integer("duration_watched"),
		isFullWatch: integer("is_full_watch", { mode: "boolean" }).notNull().default(false),

		watchedAt: integer("watched_at", { mode: "timestamp" }).notNull(),
		...DatabaseHelper.timestamps,
	},
	(t) => [
		index("history_profile_watched_idx").on(t.profileId, t.watchedAt),
		index("history_profile_media_idx").on(t.profileId, t.mediaFileId),
		index("history_media_file_idx").on(t.mediaFileId),
		// global analytics filter only by watchedAt
		index("history_watched_at_idx").on(t.watchedAt),
		check("history_duration_check", sql`${t.durationWatched} IS NULL OR ${t.durationWatched} >= 0`),
	],
);
