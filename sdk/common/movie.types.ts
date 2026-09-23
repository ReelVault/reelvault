import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { MediaFileSchema } from "./media-file.types";
import { EntitySchema } from "./schema-utils";

export const MovieSchema = EntitySchema(t.Object({ id: t.String(), stableKey: t.String(), metadataId: t.String() }));

export type Movie = typeof MovieSchema.static;

export const MovieWithRelationsSchema = t.Composite([
	MovieSchema,
	t.Object({
		mediaFiles: t.Array(MediaFileSchema),
	}),
]);

export type MovieWithRelations = typeof MovieWithRelationsSchema.static;

export const MovieFiltersSchema = t.Object({
	metadataId: t.Optional(t.String()),
});

export type MovieFilters = typeof MovieFiltersSchema.static;

export const MovieSortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(t.Union([t.Literal("createdAt"), t.Literal("updatedAt")])),
	}),
]);

export type MovieSorting = typeof MovieSortingSchema.static;
