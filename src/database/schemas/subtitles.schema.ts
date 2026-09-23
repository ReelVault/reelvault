import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { mediaFiles } from "./media-files.schema";

export const subtitles = sqliteTable(
	"subtitles",
	{
		id: DatabaseHelper.id,
		mediaFileId: DatabaseHelper.tableRef("media_file_id", () => mediaFiles.id, { onDelete: "cascade" }),

		language: text("language").notNull(),
		label: text("label"),
		format: text("format").notNull(),
		type: text("type", { enum: ["external", "embedded"] })
			.notNull()
			.default("external"),
		filePath: text("file_path"),
		streamIndex: integer("stream_index"),

		isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
		isForced: integer("is_forced", { mode: "boolean" }).notNull().default(false),
		isHearingImpaired: integer("is_hearing_impaired", { mode: "boolean" }).notNull().default(false),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("subtitles_external_unique").on(t.mediaFileId, t.language, t.type).where(sql`${t.type} = 'external'`),
		uniqueIndex("subtitles_embedded_unique").on(t.mediaFileId, t.streamIndex).where(sql`${t.type} = 'embedded'`),
		index("subtitles_media_file_idx").on(t.mediaFileId),
		check("subtitles_type_check", sql`${t.type} IN ('external', 'embedded')`),
		check(
			"subtitles_source_check",
			sql`(${t.type} = 'external' AND ${t.filePath} IS NOT NULL AND ${t.streamIndex} IS NULL)
					OR (${t.type} = 'embedded' AND ${t.streamIndex} IS NOT NULL AND ${t.filePath} IS NULL)`,
		),
	],
);
