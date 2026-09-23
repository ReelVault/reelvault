import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { MediaFileSchema } from "./media-file.types";
import { EntitySchema } from "./schema-utils";

export const MetadataStorageModeSchema = t.Union([t.Literal("database"), t.Literal("sidecar"), t.Literal("database_and_sidecar")]);

export type MetadataStorageMode = typeof MetadataStorageModeSchema.static;

/** Target dialect for sidecar NFO files. Kodi's format is the one Plex and Jellyfin also read. */
export const SidecarFlavorSchema = t.Union([t.Literal("reelvault"), t.Literal("kodi")]);

export type SidecarFlavor = typeof SidecarFlavorSchema.static;

export const LibrarySchema = EntitySchema(
	t.Object({
		id: t.String(),
		name: t.String(),
		type: t.Union([t.Literal("movies"), t.Literal("tv_shows")]),
		metadataStorageMode: MetadataStorageModeSchema,
		sidecarFlavor: SidecarFlavorSchema,
	}),
);

export type Library = typeof LibrarySchema.static;

export const LibraryTypeSchema = LibrarySchema.properties.type;

export type LibraryType = typeof LibraryTypeSchema.static;

export const LibraryPathSchema = EntitySchema(
	t.Object({
		id: t.String(),
		libraryId: t.String(),
		stableKey: t.String(),
		path: t.String(),
		isActive: t.Boolean(),
		metadataStorageMode: t.Union([t.Literal("database"), t.Literal("sidecar"), t.Literal("database_and_sidecar"), t.Null()]),
	}),
);

export const LibraryPathWithStatsSchema = t.Composite([
	LibraryPathSchema,
	t.Object({
		fileCount: t.Optional(t.Integer()),
		totalSize: t.Optional(t.Integer()),
		size: t.Optional(t.Integer()),
	}),
]);

export const LibraryWithRelationsSchema = t.Composite([
	LibrarySchema,
	t.Object({
		paths: t.Array(LibraryPathWithStatsSchema),
		// Loaded only when `fields` includes mediaFiles (or in dedicated file
		// endpoints) — row-level file lists on every library query would be
		// prohibitive, so the contract cannot promise them unconditionally.
		mediaFiles: t.Optional(t.Array(MediaFileSchema)),
		totalMediaFiles: t.Optional(t.Integer()),
		totalSize: t.Optional(t.Integer()),
		mediaFileCount: t.Optional(t.Integer()),
	}),
]);

export type LibraryWithRelations = typeof LibraryWithRelationsSchema.static;

/** GET /libraries/:libraryId — `siblings` is attached only when `?siblings=true` is passed. */
export const LibraryDetailSchema = t.Composite([
	LibraryWithRelationsSchema,
	t.Object({
		siblings: t.Optional(t.Array(LibraryWithRelationsSchema)),
	}),
]);

/** Interface (not the schema static) so `SelectFields` mapping relates it to `LibraryWithRelations`. */
export interface LibraryDetail extends LibraryWithRelations {
	siblings?: LibraryWithRelations[];
}

export const CreateLibraryPathSchema = t.Object({
	path: t.String({ minLength: 1 }),
	metadataStorageMode: t.Optional(MetadataStorageModeSchema),
});

export type CreateLibraryPath = typeof CreateLibraryPathSchema.static;

export const CreateLibrarySchema = t.Object({
	name: t.String({ minLength: 1 }),
	type: LibraryTypeSchema,
	metadataStorageMode: t.Optional(MetadataStorageModeSchema),
	sidecarFlavor: t.Optional(SidecarFlavorSchema),
	paths: t.Array(CreateLibraryPathSchema),
});

export type CreateLibrary = typeof CreateLibrarySchema.static;

export const UpdateLibrarySchema = t.Partial(CreateLibrarySchema);

export type UpdateLibrary = typeof UpdateLibrarySchema.static;

export const LibraryFiltersSchema = t.Object({
	name: t.Optional(t.String()),
	type: t.Optional(LibraryTypeSchema),
});

export type LibraryFilters = typeof LibraryFiltersSchema.static;

export const LibrarySortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(t.Union([t.Literal("name"), t.Literal("type"), t.Literal("createdAt"), t.Literal("updatedAt")])),
	}),
]);

export type LibrarySorting = typeof LibrarySortingSchema.static;
