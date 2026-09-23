import { sql } from "drizzle-orm";
import { check, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { libraries } from "./libraries.schema";

/**
 * Files a scan discovered but could not ingest (unknown structure, library type
 * mismatch, no metadata match) — surfaced to admins as "needs attention".
 * Server-internal bookkeeping, kept out of the public SDK contract
 * (`database-schema-parity.test.ts` mirrors every table column).
 */
export const scanFindings = sqliteTable(
	"scan_findings",
	{
		libraryId: DatabaseHelper.tableRef("library_id", () => libraries.id, { onDelete: "cascade" }),
		filePath: text("file_path").notNull(),
		fileName: text("file_name").notNull(),
		reason: text("reason", { enum: ["recognition_failed", "type_mismatch", "no_metadata_match"] }).notNull(),
		...DatabaseHelper.timestamps,
	},
	(table) => [
		primaryKey({ columns: [table.libraryId, table.filePath] }),
		check("scan_findings_reason_check", sql`${table.reason} IN ('recognition_failed', 'type_mismatch', 'no_metadata_match')`),
	],
);
