import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { EntitySchema } from "./schema-utils";

export const GenreSchema = EntitySchema(t.Object({ id: t.String(), stableKey: t.String(), name: t.String() }));

export type Genre = typeof GenreSchema.static;

export const CreateGenreSchema = t.Object({
	name: t.String({ minLength: 1 }),
});

export type CreateGenre = typeof CreateGenreSchema.static;

export const UpdateGenreSchema = t.Partial(CreateGenreSchema);

export type UpdateGenre = typeof UpdateGenreSchema.static;

export const GenreFiltersSchema = t.Object({
	name: t.Optional(t.String()),
});

export type GenreFilters = typeof GenreFiltersSchema.static;

export const GenreSortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(t.Union([t.Literal("name"), t.Literal("createdAt"), t.Literal("updatedAt")])),
	}),
]);

export type GenreSorting = typeof GenreSortingSchema.static;
