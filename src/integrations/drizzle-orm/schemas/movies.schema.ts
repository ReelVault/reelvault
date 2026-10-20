import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { idColumn, tableRef, timestampColumns } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { metadata } from "./metadata.schema";

export const movies = sqliteTable(
	"movies",
	{
		id: idColumn,
		stableKey: text("stable_key").notNull(),
		metadataId: tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),

		...timestampColumns,
	},
	(t) => [uniqueIndex("movies_unique").on(t.metadataId), uniqueIndex("movies_stable_key_idx").on(t.stableKey)],
);
