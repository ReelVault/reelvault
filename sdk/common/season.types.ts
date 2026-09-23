import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { EntitySchema } from "./schema-utils";

export const SeasonSchema = EntitySchema(
	t.Object({
		id: t.String(),
		stableKey: t.String(),
		metadataId: t.String(),
		imageId: t.Nullable(t.String()),
		seasonNumber: t.Integer(),
		name: t.Nullable(t.String()),
		overview: t.Nullable(t.String()),
		airDate: t.Nullable(t.String()),
		status: t.Nullable(t.String()),
	}),
);

export type Season = typeof SeasonSchema.static;

export const SeasonFiltersSchema = t.Object({
	metadataId: t.Optional(t.String()),
	name: t.Optional(t.String()),
	seasonNumber: t.Optional(t.Number()),
	airDate: t.Optional(t.String()),
	status: t.Optional(t.String()),
});

export type SeasonFilters = typeof SeasonFiltersSchema.static;

export const SeasonSortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(
			t.Union([
				t.Literal("name"),
				t.Literal("seasonNumber"),
				t.Literal("airDate"),
				t.Literal("status"),
				t.Literal("createdAt"),
				t.Literal("updatedAt"),
			]),
		),
	}),
]);

export type SeasonSorting = typeof SeasonSortingSchema.static;
