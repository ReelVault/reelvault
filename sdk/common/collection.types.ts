import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { ProviderSchema } from "./provider.types";
import { EntitySchema } from "./schema-utils";

export const CollectionSortModeSchema = t.Union([
	t.Literal("release_date", { description: "Sort by release date (ascending)." }),
	t.Literal("manual", { description: "Sort by manually configured order." }),
	t.Literal("alphabetical", { description: "Sort by title (ascending)." }),
	t.Literal("recently_added", { description: "Sort by recently added (descending)." }),
]);

export type CollectionSortMode = typeof CollectionSortModeSchema.static;

export const CollectionSchema = EntitySchema(
	t.Object({ id: t.String(), stableKey: t.String(), name: t.String(), sortMode: CollectionSortModeSchema }),
);

export type Collection = typeof CollectionSchema.static;

export const CollectionWithRelationsSchema = t.Composite([
	CollectionSchema,
	t.Object({
		providers: t.Array(ProviderSchema),
		metadataCount: t.Number(),
		/** Ranked collage posters with their image version for cache busting. */
		posterImages: t.Array(t.Object({ imageId: t.String(), updatedAt: t.Date() })),
	}),
]);

export type CollectionWithRelations = typeof CollectionWithRelationsSchema.static;

export const CreateCollectionSchema = t.Object({
	name: t.String({ minLength: 1 }),
	sortMode: t.Optional(CollectionSortModeSchema),
});

export type CreateCollection = typeof CreateCollectionSchema.static;

export const UpdateCollectionSchema = t.Partial(CreateCollectionSchema);

export type UpdateCollection = typeof UpdateCollectionSchema.static;

export const UpdateCollectionOrderSchema = t.Object({
	metadataIds: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
});

export const CollectionFiltersSchema = t.Object({
	name: t.Optional(t.String()),
	minItems: t.Optional(t.Numeric({ minimum: 1, description: "Minimum number of metadata items in a collection. Defaults to 2." })),
});

export type CollectionFilters = typeof CollectionFiltersSchema.static;

export const CollectionSortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(t.Union([t.Literal("name"), t.Literal("createdAt"), t.Literal("updatedAt")])),
	}),
]);

export type CollectionSorting = typeof CollectionSortingSchema.static;
