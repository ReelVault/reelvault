import { ProjectedResponseSchema } from "@sdk/common";
import { EpisodeFiltersSchema, EpisodeSortingSchema, EpisodeWithRelationsSchema } from "@sdk/common/episode.types";
import { Elysia, t } from "elysia";
import { commonModel, FieldsSchema, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { episodesService } from "@/application/catalog/episodes.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { MINUTE } from "@/server.constants";

export const episodesRoutes = new Elysia({
	prefix: "/episodes",
	tags: ["Episodes"],
})
	.use(commonModel)
	.use(authMiddleware)
	.model({
		"episode.schema": ProjectedResponseSchema(EpisodeWithRelationsSchema),
		"episodes.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(EpisodeWithRelationsSchema)),
	})
	.guard({ auth: true })
	.get("/", async ({ query }) => await episodesService.getAll(query), {
		query: t.Composite([PaginationSchema, FieldsSchema, EpisodeFiltersSchema, EpisodeSortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "episodes.paginated.schema" },
		cache: { maxAge: 60, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve a paginated list of episodes, optionally filtered by seasonId.",
		},
	})
	.get("/:episodeId", async ({ params, query }) => await episodesService.getById(params.episodeId, query), {
		params: t.Object({
			episodeId: t.String(),
		}),
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "episode.schema" },
		cache: { maxAge: 120, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve detailed information about a specific episode by its ID.",
		},
	})
	.post("/:episodeId/refresh", async ({ params }) => await episodesService.refresh(params.episodeId), {
		adminOnly: true,
		rateLimit: {
			name: "episode-refresh",
			max: 30,
			windowMs: MINUTE,
		},
		params: t.Object({
			episodeId: t.String(),
		}),
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "episode.schema" },
		detail: {
			description: "Refresh episode metadata and download thumbnail if missing.",
		},
	})
	.post("/:episodeId/refresh-image", async ({ params }) => await episodesService.refreshImage(params.episodeId), {
		adminOnly: true,
		rateLimit: {
			name: "episode-refresh-image",
			max: 30,
			windowMs: MINUTE,
		},
		params: t.Object({
			episodeId: t.String(),
		}),
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "episode.schema" },
		detail: {
			description: "Force download and replace episode thumbnail.",
		},
	});
