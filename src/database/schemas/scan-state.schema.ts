import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";

/**
 * Checkpoint for an interrupted library scan. One row per library holding the
 * diff the interrupted run was still enqueueing (new files → ingest, changed
 * files → refresh) plus cursors into both lists. It is used to DETECT the
 * interruption on the next scan — that scan recomputes the workload from disk
 * instead of resuming this list, because the list is stale by definition
 * (files added after the interruption are missing, ingested ones remain).
 */
export const scanState = sqliteTable(
	"scan_state",
	{
		id: DatabaseHelper.id,
		libraryId: text("library_id").notNull().unique(),
		// Comma-joined scan paths the diff was computed against — a checkpoint is
		// only resumed when the next scan targets the same paths.
		pathsSignature: text("paths_signature").notNull(),
		scannedFiles: integer("scanned_files").notNull().default(0),
		newFilePaths: text("new_file_paths", { mode: "json" }).$type<string[]>().notNull(),
		changedMediaFileIds: text("changed_media_file_ids", { mode: "json" }).$type<string[]>().notNull(),
		ingestCursor: integer("ingest_cursor").notNull().default(0),
		refreshCursor: integer("refresh_cursor").notNull().default(0),
		...DatabaseHelper.timestamps,
	},
	(table) => [index("scan_state_library_updated_idx").on(table.libraryId, table.updatedAt)],
);
