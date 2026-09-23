import { SortQuerySchema } from "@sdk/common/sorting";
import { t } from "elysia";
import { EpisodeSchema } from "./episode.types";
import { ImageSchema } from "./image.types";
import { MetadataSchema } from "./metadata.types";
import { EntitySchema } from "./schema-utils";
import { SeasonSchema } from "./season.types";

export const WatchedHistorySchema = EntitySchema(
	t.Object({
		id: t.String(),
		mediaFileId: t.String(),
		profileId: t.String(),
		durationWatched: t.Nullable(t.Integer({ minimum: 0 })),
		isFullWatch: t.Boolean(),
		watchedAt: t.Date(),
	}),
);

export const WatchedHistoryWithRelationsSchema = t.Composite([
	WatchedHistorySchema,
	t.Object({
		metadata: MetadataSchema,
		episode: t.Nullable(EpisodeSchema),
		season: t.Nullable(SeasonSchema),
		backdrop: t.Nullable(ImageSchema),
	}),
]);

export type WatchedHistoryWithRelations = typeof WatchedHistoryWithRelationsSchema.static;

export const CreateWatchedHistorySchema = t.Object({
	mediaFileId: t.String(),
	profileId: t.Optional(t.String()),

	durationWatched: t.Optional(t.Number({ minimum: 0 })),
	isFullWatch: t.Optional(t.Boolean()),
});

export type CreateWatchedHistory = typeof CreateWatchedHistorySchema.static;

export const UpdateWatchedHistorySchema = t.Partial(CreateWatchedHistorySchema);

export const WatchedHistorySortingSchema = t.Composite([
	SortQuerySchema,
	t.Object({
		sortBy: t.Optional(t.Union([t.Literal("watchedAt"), t.Literal("createdAt")])),
	}),
]);

export type WatchedHistorySorting = typeof WatchedHistorySortingSchema.static;
