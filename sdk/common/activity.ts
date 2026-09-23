import { t } from "elysia";

export const InsightsRangeSchema = t.Union([t.Literal("7d"), t.Literal("30d"), t.Literal("90d"), t.Literal("1y"), t.Literal("all")]);

export type InsightsRange = typeof InsightsRangeSchema.static;

export const RankedActivitySchema = t.Object({
	name: t.String(),
	minutes: t.Integer({ minimum: 0 }),
});

export const TopWatchedMediaSchema = t.Object({
	id: t.String(),
	title: t.String(),
	type: t.Union([t.Literal("movie"), t.Literal("tv_show")]),
	posterUrl: t.Nullable(t.String()),
	/** Version of the poster image — feeds the client's image cache key. */
	posterUpdatedAt: t.Nullable(t.Date()),
	backdropUrl: t.Nullable(t.String()),
	releaseYear: t.Nullable(t.Integer()),
	minutes: t.Integer({ minimum: 0 }),
	watchCount: t.Integer({ minimum: 0 }),
	completed: t.Boolean(),
});

export type TopWatchedMedia = typeof TopWatchedMediaSchema.static;

export const HourlyHeatmapPointSchema = t.Object({
	dayOfWeek: t.Integer({ minimum: 0, maximum: 6 }), // 0 = Sunday, 1 = Monday, ...
	hour: t.Integer({ minimum: 0, maximum: 23 }),
	minutes: t.Integer({ minimum: 0 }),
});

export type HourlyHeatmapPoint = typeof HourlyHeatmapPointSchema.static;

export const GenreDistributionSchema = t.Object({
	name: t.String(),
	minutes: t.Integer({ minimum: 0 }),
	percentage: t.Number({ minimum: 0, maximum: 100 }),
});

export type GenreDistribution = typeof GenreDistributionSchema.static;

export const ProfileInsightsSchema = t.Object({
	range: InsightsRangeSchema,
	totalMinutes: t.Integer({ minimum: 0 }),
	previousPeriodMinutes: t.Integer({ minimum: 0 }),
	dailyAverageMinutes: t.Integer({ minimum: 0 }),
	titlesWatched: t.Integer({ minimum: 0 }),
	completedTitlesCount: t.Integer({ minimum: 0 }),
	longestSessionMinutes: t.Integer({ minimum: 0 }),
	topGenre: t.Nullable(RankedActivitySchema),
	topActor: t.Nullable(RankedActivitySchema),
	topMovies: t.Array(TopWatchedMediaSchema),
	topShows: t.Array(TopWatchedMediaSchema),
	genresDistribution: t.Array(GenreDistributionSchema),
	hourlyHeatmap: t.Array(HourlyHeatmapPointSchema),
	dailyActivity: t.Array(
		t.Object({
			date: t.String(),
			minutes: t.Integer({ minimum: 0 }),
		}),
	),
});

export type ProfileInsights = typeof ProfileInsightsSchema.static;

export const WrappedInsightsSchema = t.Object({
	year: t.Integer(),
	totalMinutes: t.Integer({ minimum: 0 }),
	totalDays: t.Number({ minimum: 0 }),
	titlesWatched: t.Integer({ minimum: 0 }),
	moviesWatchedCount: t.Integer({ minimum: 0 }),
	episodesWatchedCount: t.Integer({ minimum: 0 }),
	topMovie: t.Nullable(TopWatchedMediaSchema),
	topShow: t.Nullable(TopWatchedMediaSchema),
	topMovies: t.Array(TopWatchedMediaSchema),
	topShows: t.Array(TopWatchedMediaSchema),
	topGenres: t.Array(GenreDistributionSchema),
	topActors: t.Array(RankedActivitySchema),
	peakMonth: t.Nullable(
		t.Object({
			/** 0-based month index (January = 0); the frontend formats the label. */
			month: t.Integer(),
			minutes: t.Integer(),
		}),
	),
	peakDayOfWeek: t.Nullable(
		t.Object({
			/** 0 = Sunday … 6 = Saturday; the frontend formats the label. */
			dayOfWeek: t.Integer(),
			minutes: t.Integer(),
		}),
	),
	longestMarathonMinutes: t.Integer({ minimum: 0 }),
	viewerPersonality: t.Object({
		/** Stable personality code; the frontend renders title/description. */
		code: t.String(),
		/** Locale-independent emoji badge. */
		badge: t.String(),
	}),
});

export type WrappedInsights = typeof WrappedInsightsSchema.static;

export const AdminAnalyticsUserLeaderboardSchema = t.Object({
	profileId: t.String(),
	profileName: t.String(),
	profileAvatar: t.Nullable(t.String()),
	userName: t.String(),
	userEmail: t.String(),
	totalMinutes: t.Integer({ minimum: 0 }),
	titlesCount: t.Integer({ minimum: 0 }),
	lastWatchedAt: t.Nullable(t.String()),
});

export const AdminAnalyticsStreamHistoryItemSchema = t.Object({
	id: t.String(),
	profileName: t.String(),
	userName: t.String(),
	title: t.String(),
	mediaType: t.Union([t.Literal("movie"), t.Literal("tv_show")]),
	posterUrl: t.Nullable(t.String()),
	durationWatched: t.Nullable(t.Integer()),
	isFullWatch: t.Boolean(),
	watchedAt: t.String(),
});

export const AdminAnalyticsSchema = t.Object({
	totalWatchMinutes: t.Integer({ minimum: 0 }),
	totalPlaysCount: t.Integer({ minimum: 0 }),
	activeUsersCount: t.Integer({ minimum: 0 }),
	mostWatchedTitle: t.Nullable(TopWatchedMediaSchema),
	topContent: t.Array(TopWatchedMediaSchema),
	userLeaderboard: t.Array(AdminAnalyticsUserLeaderboardSchema),
	recentPlays: t.Array(AdminAnalyticsStreamHistoryItemSchema),
	hourlyActivity: t.Array(HourlyHeatmapPointSchema),
	dailyActivity: t.Array(
		t.Object({
			date: t.String(),
			minutes: t.Integer({ minimum: 0 }),
			playCount: t.Integer({ minimum: 0 }),
		}),
	),
});

export type AdminAnalytics = typeof AdminAnalyticsSchema.static;
