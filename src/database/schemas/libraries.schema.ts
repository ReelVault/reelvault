import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { DatabaseHelper } from "../utils/database-helper";

export const libraries = sqliteTable(
	"libraries",
	{
		id: DatabaseHelper.id,

		name: text("name").notNull(),
		type: text("type", { enum: ["movies", "tv_shows"] }).notNull(),
		metadataStorageMode: text("metadata_storage_mode", { enum: ["database", "sidecar", "database_and_sidecar"] })
			.notNull()
			.default("database"),
		sidecarFlavor: text("sidecar_flavor", { enum: ["reelvault", "kodi"] })
			.notNull()
			.default("reelvault"),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("libraries_unique").on(t.name, t.type),
		check("libraries_type_check", sql`${t.type} IN ('movies', 'tv_shows')`),
		check("libraries_metadata_storage_mode_check", sql`${t.metadataStorageMode} IN ('database', 'sidecar', 'database_and_sidecar')`),
		check("libraries_sidecar_flavor_check", sql`${t.sidecarFlavor} IN ('reelvault', 'kodi')`),
	],
);

export const libraryPaths = sqliteTable(
	"library_paths",
	{
		id: DatabaseHelper.id,
		libraryId: DatabaseHelper.tableRef("library_id", () => libraries.id, { onDelete: "cascade" }),
		stableKey: text("stable_key").notNull(),

		path: text("path").notNull(),
		isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
		metadataStorageMode: text("metadata_storage_mode", { enum: ["database", "sidecar", "database_and_sidecar"] }),

		...DatabaseHelper.timestamps,
	},
	(t) => [
		uniqueIndex("library_paths_unique").on(t.path),
		index("library_paths_library_idx").on(t.libraryId),
		uniqueIndex("library_paths_stable_key_idx").on(t.stableKey),
		check(
			"library_paths_metadata_storage_mode_check",
			sql`${t.metadataStorageMode} IS NULL OR ${t.metadataStorageMode} IN ('database', 'sidecar', 'database_and_sidecar')`,
		),
	],
);
