import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { mediaFiles } from "./media-files.schema";
import { profiles } from "./profiles.schema";

/**
 * Playback sessions that ended before the title was finished, with the media time they played. Watched history keeps
 * only finished titles (the user-facing history and insights read it); the admin analytics add these sessions on top.
 */
export const interruptedPlaybackSessions = sqliteTable(
	"interrupted_playback_sessions",
	{
		id: DatabaseHelper.id,
		profileId: DatabaseHelper.tableRef("profile_id", () => profiles.id, { onDelete: "cascade" }),
		mediaFileId: DatabaseHelper.tableRef("media_file_id", () => mediaFiles.id, { onDelete: "cascade" }),

		startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
		endedAt: integer("ended_at", { mode: "timestamp" }).notNull(),
		playedSeconds: integer("played_seconds").notNull(),
		furthestPositionSeconds: integer("furthest_position_seconds").notNull(),
		durationSeconds: integer("duration_seconds"),
		reason: text("reason").notNull(),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		index("interrupted_sessions_profile_ended_idx").on(t.profileId, t.endedAt),
		index("interrupted_sessions_media_idx").on(t.mediaFileId),
		index("interrupted_sessions_ended_idx").on(t.endedAt),
		check("interrupted_sessions_played_check", sql`${t.playedSeconds} >= 0`),
	],
);
