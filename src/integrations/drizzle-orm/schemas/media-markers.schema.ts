import { mediaMarkerSources, mediaMarkerTypes } from "@reelvault/sdk/common";
import { sql } from "drizzle-orm";
import { check, index, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { mediaFiles } from "./media-files.schema";

export const mediaMarkers = sqliteTable(
	"media_markers",
	{
		id: DatabaseHelper.id,
		mediaFileId: DatabaseHelper.tableRef("media_file_id", () => mediaFiles.id, { onDelete: "cascade" }),

		type: text("type", { enum: mediaMarkerTypes }).notNull(),
		startSeconds: real("start_seconds").notNull(),
		endSeconds: real("end_seconds").notNull(),
		label: text("label"),
		source: text("source", { enum: mediaMarkerSources }).notNull().default("manual"),
		pluginId: text("plugin_id"),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		// media_file_id-only lookups are served by the two composites below.
		index("media_markers_media_file_type_idx").on(t.mediaFileId, t.type),
		index("media_markers_file_start_idx").on(t.mediaFileId, t.startSeconds),
		// The list page sorts by created_at and appends the id as a tiebreaker.
		index("media_markers_created_at_id_idx").on(t.createdAt, t.id),
		check("media_markers_range_check", sql`${t.startSeconds} >= 0 AND ${t.endSeconds} >= ${t.startSeconds}`),
	],
);
