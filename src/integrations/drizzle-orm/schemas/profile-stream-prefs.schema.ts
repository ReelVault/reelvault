import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tableRef, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { metadata } from "./metadata.schema";
import { profiles } from "./profiles.schema";

/**
 * Per-profile audio/subtitle language chosen while watching a title (movies)
 * or any episode of a series (metadata level), so the next episode starts with
 * the same languages without re-picking them. Track indices are file-specific
 * and stay in playback_progress — this table only carries languages.
 */
export const profileStreamPrefs = sqliteTable(
	"profile_stream_prefs",
	{
		profileId: tableRef("profile_id", () => profiles.id, { onDelete: "cascade" }),
		metadataId: tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),

		audioLanguage: text("audio_language"),
		subtitleLanguage: text("subtitle_language"),

		...timestampColumns,
	},
	(t) => [primaryKey({ columns: [t.profileId, t.metadataId] }), index("profile_stream_prefs_media_idx").on(t.metadataId)],
);
