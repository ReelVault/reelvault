import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { idColumn, tableRef, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { mediaFiles } from "./media-files.schema";
import { profiles } from "./profiles.schema";

export const watchedHistory = sqliteTable(
	"watched_history",
	{
		id: idColumn,
		mediaFileId: tableRef("media_file_id", () => mediaFiles.id, { onDelete: "cascade" }),
		profileId: tableRef("profile_id", () => profiles.id, { onDelete: "cascade" }),

		durationWatched: integer("duration_watched"),
		isFullWatch: integer("is_full_watch", { mode: "boolean" }).notNull().default(false),

		watchedAt: integer("watched_at", { mode: "timestamp" }).notNull(),
		...timestampColumns,
	},
	(t) => [
		// The default listing is a keyset page over (watchedAt, id): without the
		// id in the index the sort falls back to a temp B-tree over a full scan.
		index("history_profile_watched_id_idx").on(t.profileId, t.watchedAt, t.id),
		// `sortBy=createdAt` on the watched-history page needs the id tiebreaker.
		index("history_profile_created_idx").on(t.profileId, t.createdAt, t.id),
		index("history_profile_media_idx").on(t.profileId, t.mediaFileId),
		index("history_media_file_idx").on(t.mediaFileId),
		// global analytics filter only by watchedAt
		index("history_watched_at_idx").on(t.watchedAt),
		check("history_duration_check", sql`${t.durationWatched} IS NULL OR ${t.durationWatched} >= 0`),
	],
);
