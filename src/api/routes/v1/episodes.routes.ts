import { EpisodeFiltersSchema, EpisodeSortingSchema, EpisodeWithRelationsSchema } from "@reelvault/sdk/common";
import { ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { EpisodeIdParams } from "@/api/schemas/route-params";
import { episodesService } from "@/application/catalog/episodes.service";
import { MINUTE } from "@/server.constants";
import { createCatalogResourceRoutes } from "./shared/create-catalog-resource-routes";

export const episodesRoutes = createCatalogResourceRoutes({
	prefix: "/episodes",
	tag: "Episodes",
	name: "episode",
	service: episodesService,
	entity: EpisodeWithRelationsSchema,
	filters: EpisodeFiltersSchema,
	sorting: EpisodeSortingSchema,
	params: EpisodeIdParams,
	cacheMaxAge: { list: 60, detail: 120 },
	descriptions: {
		list: "Retrieve a paginated list of episodes, optionally filtered by seasonId.",
		detail: "Retrieve detailed information about a specific episode by its ID.",
	},
})
	.post("/:episodeId/refresh", async ({ params }) => await episodesService.refresh(params.episodeId), {
		adminOnly: true,
		rateLimit: {
			name: "episode-refresh",
			max: 30,
			windowMs: MINUTE,
		},
		params: EpisodeIdParams,
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
		params: EpisodeIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "episode.schema" },
		detail: {
			description: "Force download and replace episode thumbnail.",
		},
	});
