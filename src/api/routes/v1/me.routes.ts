import {
	BatchSmartPlayResponseSchema,
	ContinueWatchingResponseSchema,
	CreateUserRatingSchema,
	CreateWatchedHistorySchema,
	CreateWatchlistSchema,
	HydratedWatchlistItemSchema,
	InsightsRangeSchema,
	MetadataPlaybackProgressSchema,
	ProfileInsightsSchema,
	ProjectedResponseSchema,
	SessionResponseSchema,
	SmartPlayResponseSchema,
	StreamPrefsSchema,
	UpdatePlaybackProgressSchema,
	UserRatingFiltersSchema,
	UserRatingSchema,
	UserRatingSortingSchema,
	WatchedHistorySortingSchema,
	WatchedHistoryWithRelationsSchema,
	WatchlistFiltersSchema,
	WatchlistSchema,
	WatchlistSortingSchema,
	WatchlistStatusesResponseSchema,
	WrappedInsightsSchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import {
	ClampedNumeric,
	commonModel,
	FieldsSchema,
	PaginatedResponseSchema,
	PaginationSchema,
	ROUTE_ERRORS,
} from "@/api/schemas/common.schemas";
import { MediaFileIdParams, MetadataIdParams } from "@/api/schemas/route-params";
import { authService } from "@/application/auth/auth.service";
import { userRatingsService } from "@/application/users/user-ratings.service";
import { watchedHistoryService } from "@/application/users/watched-history.service";
import { watchlistService } from "@/application/users/watchlist.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { cached } from "@/middleware/response-cache.middleware";
import { playbackProgressService } from "@/modules/streaming/progress/playback-progress.service";
import { assertActiveStreamAccess } from "@/modules/streaming/sessions/stream-access";
import { trimAndFilter } from "@/utils/array.utils";

export const meRoutes = new Elysia({ prefix: "/me", tags: ["My Profile & Playback"] })
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.model({
		"me.session.response": SessionResponseSchema,

		"me.watchlist.schema": ProjectedResponseSchema(WatchlistSchema),
		"me.watchlist.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(WatchlistSchema)),
		"me.watchlist.hydrated.paginated.schema": PaginatedResponseSchema(HydratedWatchlistItemSchema),
		"me.playback-suggestions.batch.response": BatchSmartPlayResponseSchema,
		"me.watchlist.toggle.body": CreateWatchlistSchema,
		"me.watchlist.toggle.response": t.Object({ added: t.Boolean() }),
		"me.watchlist.status.response": t.Object({ inWatchlist: t.Boolean() }),
		"me.watchlist.statuses.response": WatchlistStatusesResponseSchema,

		"me.watchedHistory.schema": WatchedHistoryWithRelationsSchema,
		"me.watchedHistory.paginated.schema": PaginatedResponseSchema(WatchedHistoryWithRelationsSchema),
		"me.watchedHistory.sync.body": CreateWatchedHistorySchema,
		"me.watchedHistory.isWatched.response": t.Object({ watched: t.Boolean() }),

		"me.userRating.schema": ProjectedResponseSchema(UserRatingSchema),
		"me.userRatings.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(UserRatingSchema)),
		"me.userRating.create.body": CreateUserRatingSchema,
	})
	.guard({ auth: true, profileRequired: true })

	// --- ACCOUNT & PROFILE ME ---
	.get("/", async ({ session, user, profile }) => await authService.getMe(session, user, profile), {
		response: { ...ROUTE_ERRORS.AUTH, 200: "me.session.response" },
		detail: {
			description: "Returns information about current user, session, and active profile.",
		},
	})

	// --- PLAYBACK & CONTINUE WATCHING ---
	.get("/continue-watching", async ({ query, profile }) => await playbackProgressService.getContinueWatching(profile?.id, query.limit), {
		query: t.Object({ limit: t.Optional(ClampedNumeric(1, 50)) }),
		response: { ...ROUTE_ERRORS.AUTH, 200: ContinueWatchingResponseSchema },
		...cached({ maxAge: 10, private: true }),
		detail: { description: "Retrieve items to continue watching for the active profile." },
	})
	.get(
		"/playback-progress/:metadataId",
		async ({ params, profile }) => await playbackProgressService.getPlaybackProgress(params.metadataId, profile?.id),
		{
			params: MetadataIdParams,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: MetadataPlaybackProgressSchema },
			...cached({ maxAge: 10, private: true }),
			detail: {
				description:
					"Retrieve playback progress for a specific title, including per-file saved progress resolved server-side (fileProgress).",
			},
		},
	)
	.put(
		"/media-files/:mediaFileId/playback-progress",
		async ({ params, body, user, profile }) => {
			await assertActiveStreamAccess({ userId: user?.id, profileId: profile?.id, mediaFileId: params.mediaFileId });

			return await playbackProgressService.updatePlaybackProgress(params.mediaFileId, body, profile?.id);
		},
		{
			params: MediaFileIdParams,
			body: UpdatePlaybackProgressSchema,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "success.response" },
			detail: { description: "Update playback progress position for a media file." },
		},
	)
	.get(
		"/stream-prefs/:mediaFileId",
		async ({ params, profile }) => {
			const prefs = await playbackProgressService.getStreamPrefs(params.mediaFileId, profile?.id);

			return { audioLanguage: prefs?.audioLanguage ?? null, subtitleLanguage: prefs?.subtitleLanguage ?? null };
		},
		{
			params: MediaFileIdParams,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: StreamPrefsSchema },
			detail: {
				description:
					"Audio/subtitle languages the user picked for this title or series — clients apply them when starting the next episode.",
			},
		},
	)
	.delete(
		"/media-files/:mediaFileId/playback-progress",
		async ({ params, user, profile }) => {
			await assertActiveStreamAccess({ userId: user?.id, profileId: profile?.id, mediaFileId: params.mediaFileId });

			return await playbackProgressService.resetPlaybackProgress(params.mediaFileId, profile?.id);
		},
		{
			params: MediaFileIdParams,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "success.response" },
			detail: { description: "Reset playback progress for a media file." },
		},
	)
	.get(
		"/playback-suggestions",
		async ({ query, profile }) => {
			const ids = trimAndFilter(query.metadataIds.split(","));

			return await playbackProgressService.getSmartPlayBatch(ids, profile?.id);
		},
		{
			query: t.Object({ metadataIds: t.String({ maxLength: 2000 }) }),
			response: { ...ROUTE_ERRORS.AUTH, 200: "me.playback-suggestions.batch.response" },
			detail: { description: "Batch smart-play suggestions + watchlist flags for card grids (max 50 ids)." },
		},
	)
	.get(
		"/playback-suggestions/:metadataId",
		async ({ params, profile }) => await playbackProgressService.getSmartPlay(params.metadataId, profile?.id),
		{
			params: MetadataIdParams,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: SmartPlayResponseSchema },
			detail: { description: "Get smart play / next episode playback suggestion." },
		},
	)

	// --- WATCHLIST ---
	.get("/watchlist", async ({ query, profile }) => await watchlistService.getAll(query, profile?.id), {
		query: t.Composite([
			PaginationSchema,
			FieldsSchema,
			WatchlistFiltersSchema,
			WatchlistSortingSchema,
			t.Object({ hydrate: t.Optional(t.Union([t.Boolean(), t.BooleanString()])) }),
		]),
		response: {
			...ROUTE_ERRORS.AUTH,
			200: t.Union([t.Ref("me.watchlist.paginated.schema"), t.Ref("me.watchlist.hydrated.paginated.schema")]),
		},
		...cached({ maxAge: 10, private: true }),
		detail: {
			description:
				"Retrieve watchlist items for the active profile. With hydrate=true every item embeds its full metadata card (single-request hydration).",
		},
	})
	.post("/watchlist", async ({ body, profile }) => await watchlistService.add(body.metadataId, profile?.id), {
		body: t.Object({ metadataId: t.String() }),
		response: { ...ROUTE_ERRORS.AUTH, 200: "success.response" },
		detail: { description: "Add a title to the watchlist." },
	})
	.delete("/watchlist/:metadataId", async ({ params, profile }) => await watchlistService.remove(params.metadataId, profile?.id), {
		params: MetadataIdParams,
		response: { ...ROUTE_ERRORS.AUTH, 200: "success.response" },
		detail: { description: "Remove a title from the watchlist." },
	})
	// Static segment BEFORE :metadataId (the router must prefer "statuses" over the param).
	.get(
		"/watchlist/statuses",
		async ({ query, profile }) => {
			const metadataIds = trimAndFilter(query.ids.split(","));

			return await watchlistService.getStatuses(metadataIds, profile?.id);
		},
		{
			query: t.Object({ ids: t.String() }),
			response: { ...ROUTE_ERRORS.AUTH, 200: "me.watchlist.statuses.response" },
			...cached({ maxAge: 10, private: true }),
			detail: { description: "Batch check which titles are in the watchlist for the active profile." },
		},
	)
	.get("/watchlist/:metadataId", async ({ params, profile }) => await watchlistService.isWatchlisted(params.metadataId, profile?.id), {
		params: MetadataIdParams,
		response: { ...ROUTE_ERRORS.AUTH, 200: "me.watchlist.status.response" },
		detail: { description: "Check if a title is in the watchlist." },
	})
	.post("/watchlist/toggle", async ({ body, profile }) => await watchlistService.toggle(body, profile?.id), {
		body: "me.watchlist.toggle.body",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "me.watchlist.toggle.response" },
		detail: { description: "Toggle an item in the watchlist for the active profile." },
	})

	// --- WATCHED HISTORY ---
	.get("/watched-history", async ({ query, profile }) => await watchedHistoryService.getAll(query, profile?.id), {
		query: t.Composite([PaginationSchema, WatchedHistorySortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "me.watchedHistory.paginated.schema" },
		...cached({ maxAge: 10, private: true }),
		detail: { description: "Retrieve watched history for the active profile." },
	})
	.post("/watched-history", async ({ body, profile }) => await watchedHistoryService.sync(body, profile?.id), {
		body: "me.watchedHistory.sync.body",
		response: { ...ROUTE_ERRORS.AUTH, 200: "success.response" },
		detail: { description: "Log a watched history entry for the active profile." },
	})
	.get("/watched-history/insights", async ({ query, profile }) => await watchedHistoryService.getInsights(query.range, profile?.id), {
		query: t.Object({ range: InsightsRangeSchema }),
		response: { ...ROUTE_ERRORS.AUTH, 200: ProfileInsightsSchema },
		...cached({ maxAge: 30, private: true }),
		detail: { description: "Aggregate profile viewing activity insights." },
	})
	.get(
		"/watched-history/wrapped",
		async ({ query, profile }) => {
			const targetYear = query.year ?? new Date().getFullYear();

			return await watchedHistoryService.getWrapped(targetYear, profile?.id);
		},
		{
			query: t.Object({ year: t.Optional(t.Numeric({ minimum: 2000, maximum: 2100 })) }),
			response: { ...ROUTE_ERRORS.AUTH, 200: WrappedInsightsSchema },
			...cached({ maxAge: 60, private: true }),
			detail: { description: "Get annual year-in-review summary for the active profile (ReelVault Wrapped)." },
		},
	)
	.get(
		"/watched-history/:metadataId/watched",
		async ({ params, profile }) => await watchedHistoryService.isWatched(params.metadataId, profile?.id),
		{
			params: MetadataIdParams,
			response: { ...ROUTE_ERRORS.AUTH, 200: "me.watchedHistory.isWatched.response" },
			detail: { description: "Check if a metadata item has been watched." },
		},
	)
	.delete("/watched-history", async ({ profile }) => await watchedHistoryService.clear(profile?.id), {
		response: { ...ROUTE_ERRORS.AUTH, 200: "success.response" },
		detail: { description: "Clear all watched history for the active profile." },
	})

	// --- USER RATINGS ---
	.get("/ratings", async ({ query, profile }) => await userRatingsService.getRatings(query, profile?.id), {
		query: t.Composite([PaginationSchema, FieldsSchema, UserRatingFiltersSchema, UserRatingSortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "me.userRatings.paginated.schema" },
		...cached({ maxAge: 10, private: true }),
		detail: { description: "Retrieve all user ratings for the active profile." },
	})
	.post("/ratings", async ({ body, profile }) => await userRatingsService.rate(body, profile?.id), {
		body: "me.userRating.create.body",
		response: { ...ROUTE_ERRORS.VALIDATED, 201: "me.userRating.schema" },
		detail: { description: "Rate a title for the active profile." },
	})
	.delete("/ratings/:metadataId", async ({ params, profile }) => await userRatingsService.delete(params.metadataId, profile?.id), {
		params: MetadataIdParams,
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "success.response" },
		detail: { description: "Remove a rating for the active profile." },
	});
