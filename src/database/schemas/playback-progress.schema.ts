import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { mediaFiles } from "./media-files.schema";
import { profiles } from "./profiles.schema";

export const playbackProgress = sqliteTable(
	"playback_progress",
	{
		id: DatabaseHelper.id,
		profileId: DatabaseHelper.tableRef("profile_id", () => profiles.id, { onDelete: "cascade" }),
		mediaFileId: DatabaseHelper.tableRef("media_file_id", () => mediaFiles.id, { onDelete: "cascade" }),

		position: integer("position").notNull().default(0),
		duration: integer("duration").notNull().default(0),
		completed: integer("completed", { mode: "boolean" }).notNull().default(false),
		audioStreamIndex: integer("audio_stream_index"),
		subtitleId: text("subtitle_id"),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("playback_progress_profile_media_unique").on(t.profileId, t.mediaFileId),
		index("playback_progress_media_idx").on(t.mediaFileId),
		index("playback_progress_profile_active_idx").on(t.profileId, t.completed, t.updatedAt),
		// Continue-watching orders by updated_at with only profile_id equality —
		// the (profile_id, completed, updated_at) index can't serve that ordering.
		index("playback_progress_profile_updated_idx").on(t.profileId, t.updatedAt),
		check("playback_progress_values_check", sql`${t.position} >= 0 AND ${t.duration} >= 0`),
	],
);
