import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tableRef } from "@/integrations/drizzle-orm/query/database-helper.utils";
import { metadata } from "./metadata.schema";

export const metadataExternalIds = sqliteTable(
	"metadata_external_ids",
	{
		metadataId: tableRef("metadata_id", () => metadata.id, { onDelete: "cascade" }),
		identifierType: text("identifier_type").notNull(),
		identifier: text("identifier").notNull(),
	},
	(table) => [
		// PK already enforces one identifier per (metadata, type) and covers
		// metadata_id lookups as its leftmost column. The value lookup must NOT be
		// globally unique — the same external id can be shared by several local
		// rows (duplicates/rematches).
		primaryKey({ columns: [table.metadataId, table.identifierType] }),
		index("metadata_external_ids_type_value_idx").on(table.identifierType, table.identifier),
	],
);
