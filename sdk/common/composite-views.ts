import { EpisodeSchema, EpisodeWithRelationsSchema } from "@sdk/common/episode.types";
import { MediaFileSchema, MediaFileWithRelationSchema } from "@sdk/common/media-file.types";
import { MetadataSchema, MetadataWithRelationSchema } from "@sdk/common/metadata.types";
import { SeasonSchema } from "@sdk/common/season.types";
import { t } from "elysia";
import { ProjectedResponseSchema } from "./api";
import { MediaMarkerSchema } from "./media-markers";
import { MetadataPlaybackProgressSchema, PlaybackProgressItemSchema, SmartPlaySuggestionSchema } from "./stream";
import { SubtitleSchema } from "./subtitles";

export const SeasonWithEpisodesSchema = t.Composite([
	SeasonSchema,
	t.Object({
		episodes: t.Array(EpisodeWithRelationsSchema),
	}),
]);

export type SeasonWithEpisodes = typeof SeasonWithEpisodesSchema.static;

/**
 * Composite View for Full Player Initialisation
 */
export const PlaybackViewResponseSchema = t.Object({
	mediaFile: ProjectedResponseSchema(MediaFileWithRelationSchema),
	metadata: ProjectedResponseSchema(MetadataSchema),
	episode: t.Nullable(ProjectedResponseSchema(EpisodeSchema)),
	markers: t.Array(MediaMarkerSchema),
	subtitles: t.Array(SubtitleSchema),
	progress: t.Nullable(PlaybackProgressItemSchema),
	nextEpisode: t.Nullable(SmartPlaySuggestionSchema),
});

export type PlaybackViewResponse = typeof PlaybackViewResponseSchema.static;

/**
 * Composite View for Movie / TV Show Details Screen
 */
// Full rows, not field projections — the details service always returns the
// complete aggregate, so every field is required in the contract.
export const MetadataDetailsViewResponseSchema = t.Object({
	metadata: MetadataWithRelationSchema,
	mediaFiles: t.Array(MediaFileSchema),
	seasons: t.Array(SeasonWithEpisodesSchema),
	userState: t.Object({
		inWatchlist: t.Boolean(),
		rating: t.Nullable(t.Number()),
		isWatched: t.Boolean(),
		progress: t.Nullable(MetadataPlaybackProgressSchema),
	}),
	// Server-resolved smart play (resume/next episode) for this title.
	smartPlay: t.Nullable(SmartPlaySuggestionSchema),
});

export type MetadataDetailsViewResponse = typeof MetadataDetailsViewResponseSchema.static;
