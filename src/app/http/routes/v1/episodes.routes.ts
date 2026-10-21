import { EpisodeFiltersSchema, EpisodeSortingSchema, EpisodeWithRelationsSchema } from "@reelvault/sdk/common";
import { episodesService } from "@/app/catalog/episodes.service";
import { EpisodeIdParams } from "@/app/http/schemas/route-params.schema";
import { createRefreshableCatalogResourceRoutes } from "./shared/create-catalog-resource.routes";

export const episodesRoutes = createRefreshableCatalogResourceRoutes({
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
	refresh: {
		refresh: (id) => episodesService.refresh(id),
		refreshImage: (id) => episodesService.refreshImage(id),
		refreshMany: (ids) => episodesService.refreshMany(ids),
		descriptions: {
			refresh: "Refresh episode metadata and download thumbnail if missing.",
			refreshImage: "Force download and replace episode thumbnail.",
			refreshMany: "Refresh up to 50 episodes in turn. Each id reports its own outcome, so one failure does not stop the others.",
		},
	},
});
