import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";
import { libraries } from "./libraries.schema";

/** Per-library metadata provider overrides — omitted providers keep the global order. */
export const libraryProviderSettings = sqliteTable(
	"library_provider_settings",
	{
		libraryId: DatabaseHelper.tableRef("library_id", () => libraries.id, { onDelete: "cascade" }),
		providerId: text("provider_id").notNull(),
		priority: integer("priority").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
	},
	(t) => [primaryKey({ columns: [t.libraryId, t.providerId] })],
);
