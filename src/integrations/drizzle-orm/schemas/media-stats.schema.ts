import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { libraries } from "./libraries.schema";

/**
 * Maintained aggregate of `media_files` per library. Written in the same
 * transaction as every media-file change; `rebuildMediaStats()` seeds and can
 * repair it. The read path falls back to the live `GROUP BY` until the catalog
 * row exists, so tests and a pre-backfill database keep their old behaviour.
 */
export const libraryMediaStats = sqliteTable("library_media_stats", {
	libraryId: text("library_id")
		.primaryKey()
		.references(() => libraries.id, { onDelete: "cascade" }),
	fileCount: integer("file_count").notNull().default(0),
	totalSize: integer("total_size").notNull().default(0),
	movieCount: integer("movie_count").notNull().default(0),
	episodeCount: integer("episode_count").notNull().default(0),
	qualityCount: integer("quality_count").notNull().default(0),
});

/** One row (`id = 1`) with the global media-file counters used by the admin dashboard. */
export const catalogMediaStats = sqliteTable("catalog_media_stats", {
	id: integer("id").primaryKey(),
	fileCount: integer("file_count").notNull().default(0),
	totalSize: integer("total_size").notNull().default(0),
	movieCount: integer("movie_count").notNull().default(0),
	episodeCount: integer("episode_count").notNull().default(0),
	qualityCount: integer("quality_count").notNull().default(0),
});
