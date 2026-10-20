import { integer, primaryKey, sqliteTable } from "drizzle-orm/sqlite-core";
import { tableRef, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { mediaFiles } from "./media-files.schema";

/**
 * Server-internal ingest bookkeeping. Tracks whether the post-create side
 * effects (sidecar write, `media.file.discovered` emission) already ran so a
 * crashed-then-retried ingest can complete exactly the missing ones.
 *
 * Kept out of `media_files` on purpose: those flags are not part of the public
 * SDK contract (`database-schema-parity.test.ts` mirrors every table column).
 */
export const mediaFileIngestState = sqliteTable(
	"media_file_ingest_state",
	{
		mediaFileId: tableRef("media_file_id", () => mediaFiles.id, { onDelete: "cascade" }),
		sidecarWrittenAt: integer("sidecar_written_at", { mode: "timestamp" }),
		discoveredEmittedAt: integer("discovered_emitted_at", { mode: "timestamp" }),
		...timestampColumns,
	},
	(table) => [primaryKey({ columns: [table.mediaFileId] })],
);
