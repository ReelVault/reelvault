import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { MediaFileSchema } from "./media-file.types";
import { EntitySchema } from "./schema-utils";

export const EpisodeSchema = EntitySchema(
	t.Object({
		id: t.String(),
		stableKey: t.String(),
		seasonId: t.String(),
		imageId: t.Nullable(t.String()),
		episodeType: t.Union([t.Literal("regular"), t.Literal("special")]),
		episodeNumber: t.Integer(),
		absoluteNumber: t.Nullable(t.Integer()),
		title: t.Nullable(t.String()),
		overview: t.Nullable(t.String()),
		airDate: t.Nullable(t.String()),
	}),
);

export type Episode = typeof EpisodeSchema.static;

export const EpisodeTypeSchema = EpisodeSchema.properties.episodeType;

export type EpisodeType = typeof EpisodeTypeSchema.static;

export const EpisodeWithRelationsSchema = t.Composite([
	EpisodeSchema,
	t.Object({
		mediaFiles: t.Array(MediaFileSchema),
	}),
]);

export type EpisodeWithRelations = typeof EpisodeWithRelationsSchema.static;

export const EpisodeFiltersSchema = t.Object({
	seasonId: t.Optional(t.String()),
	metadataId: t.Optional(t.String()),
	episodeNumber: t.Optional(t.Number()),
	title: t.Optional(t.String()),
	type: t.Optional(EpisodeTypeSchema),
	airDate: t.Optional(t.String()),
});

export type EpisodeFilters = typeof EpisodeFiltersSchema.static;

export const EpisodeSortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(
			t.Union([t.Literal("title"), t.Literal("episodeNumber"), t.Literal("airDate"), t.Literal("createdAt"), t.Literal("updatedAt")]),
		),
	}),
]);

export type EpisodeSorting = typeof EpisodeSortingSchema.static;
