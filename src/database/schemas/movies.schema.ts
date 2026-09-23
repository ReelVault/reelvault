import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { metadata } from "./metadata.schema";

export const movies = sqliteTable(
	"movies",
	{
		id: DatabaseHelper.id,
		stableKey: text("stable_key").notNull(),
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),

		...DatabaseHelper.timestamps,
	},
	(t) => [uniqueIndex("movies_unique").on(t.metadataId), uniqueIndex("movies_stable_key_idx").on(t.stableKey)],
);
