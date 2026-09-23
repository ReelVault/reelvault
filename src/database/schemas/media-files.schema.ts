import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { episodes } from "./episodes.schema";
import { libraries } from "./libraries.schema";
import { metadata } from "./metadata.schema";
import { movies } from "./movies.schema";

export const mediaFiles = sqliteTable(
	"media_files",
	{
		id: DatabaseHelper.id,
		libraryId: DatabaseHelper.tableRef("library_id", () => libraries.id, { onDelete: "cascade" }),
		// A metadata record can be referenced by media files from multiple libraries.
		// Deleting one media file must never cascade into the shared metadata graph.
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id),
		movieId: DatabaseHelper.nullableTableRef("movie_id", () => movies.id, { onDelete: "cascade" }),
		episodeId: DatabaseHelper.nullableTableRef("episode_id", () => episodes.id, { onDelete: "cascade" }),

		filePath: text("file_path").notNull(),
		fileName: text("file_name").notNull(),
		formatName: text("format_name"),
		duration: integer("duration"),
		size: integer("file_size"),
		sourceMtimeMs: integer("source_mtime_ms"),
		bitRate: integer("bit_rate"),

		source: text("source"),
		edition: text("edition"),
		qualityTag: text("quality_tag"),
		isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
		isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("media_files_path_unique").on(t.filePath),
		uniqueIndex("media_files_movie_default_unique").on(t.movieId).where(sql`${t.movieId} IS NOT NULL AND ${t.isDefault} = 1`),
		uniqueIndex("media_files_episode_default_unique").on(t.episodeId).where(sql`${t.episodeId} IS NOT NULL AND ${t.isDefault} = 1`),
		index("media_files_library_idx").on(t.libraryId),
		index("media_files_library_created_idx").on(t.libraryId, t.createdAt),
		// (metadata_id, created_at) serves both plain metadata_id lookups and the
		// max(created_at) GROUP BY metadata_id scan in findRecentlyAdded.
		index("media_files_metadata_created_idx").on(t.metadataId, t.createdAt),
		index("media_files_movie_idx").on(t.movieId),
		index("media_files_episode_idx").on(t.episodeId),
		index("media_files_updated_at_idx").on(t.updatedAt),
		// Admin media-files list can ORDER BY file_name — without this it full-scans + temp-sorts.
		index("media_files_file_name_idx").on(t.fileName),
		check("media_files_single_target_check", sql`(${t.movieId} IS NULL) <> (${t.episodeId} IS NULL)`),
		check(
			"media_files_numeric_values_check",
			sql`(${t.duration} IS NULL OR ${t.duration} >= 0)
					AND (${t.size} IS NULL OR ${t.size} >= 0)
					AND (${t.sourceMtimeMs} IS NULL OR ${t.sourceMtimeMs} >= 0)
					AND (${t.bitRate} IS NULL OR ${t.bitRate} >= 0)`,
		),
	],
);

export const mediaFileVideoStreams = sqliteTable(
	"media_file_video_streams",
	{
		mediaFileId: DatabaseHelper.tableRef("media_file_id", () => mediaFiles.id, { onDelete: "cascade" }),

		index: integer("index").notNull(),
		codecName: text("codec_name").notNull(),
		codecLongName: text("codec_long_name"),
		profile: text("profile"),
		width: integer("width").notNull(),
		height: integer("height").notNull(),
		pixelFormat: text("pixel_format"),
		colorTransfer: text("color_transfer"),
		colorPrimaries: text("color_primaries"),
		colorSpace: text("color_space"),
		doviProfile: integer("dovi_profile"),
		frameRate: text("frame_rate"),
		bitRate: integer("bit_rate"),
		language: text("language"),
		title: text("title"),
		isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
		isForced: integer("is_forced", { mode: "boolean" }).notNull().default(false),
	},
	(t) => [
		primaryKey({ columns: [t.mediaFileId, t.index] }),
		check(
			"media_file_video_stream_values_check",
			sql`${t.index} >= 0
					AND ${t.width} > 0
					AND ${t.height} > 0
					AND (${t.bitRate} IS NULL OR ${t.bitRate} >= 0)`,
		),
	],
);

export const mediaFileAudioStreams = sqliteTable(
	"media_file_audio_streams",
	{
		mediaFileId: DatabaseHelper.tableRef("media_file_id", () => mediaFiles.id, { onDelete: "cascade" }),

		index: integer("index").notNull(),
		codecName: text("codec_name").notNull(),
		codecLongName: text("codec_long_name"),
		channels: integer("channels").notNull(),
		channelLayout: text("channel_layout"),
		sampleRate: integer("sample_rate"),
		bitRate: integer("bit_rate"),
		language: text("language"),
		title: text("title"),
		isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
		isForced: integer("is_forced", { mode: "boolean" }).notNull().default(false),
		isCommentary: integer("is_commentary", { mode: "boolean" }).notNull().default(false),
	},
	(t) => [
		primaryKey({ columns: [t.mediaFileId, t.index] }),
		check(
			"media_file_audio_stream_values_check",
			sql`${t.index} >= 0
					AND ${t.channels} > 0
					AND (${t.sampleRate} IS NULL OR ${t.sampleRate} > 0)
					AND (${t.bitRate} IS NULL OR ${t.bitRate} >= 0)`,
		),
	],
);
