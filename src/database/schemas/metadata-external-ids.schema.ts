import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { metadata } from "./metadata.schema";

export const metadataExternalIds = sqliteTable(
	"metadata_external_ids",
	{
		metadataId: DatabaseHelper.tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),
		identifierType: text("identifier_type").notNull(),
		identifier: text("identifier").notNull(),
	},
	(table) => [
		// PK already enforces one identifier per (metadata, type); the value lookup
		// must NOT be globally unique — the same external id can be shared by
		// several local rows (duplicates/rematches).
		primaryKey({ columns: [table.metadataId, table.identifierType] }),
		index("metadata_external_ids_type_value_idx").on(table.identifierType, table.identifier),
		index("metadata_external_ids_metadata_idx").on(table.metadataId),
	],
);
