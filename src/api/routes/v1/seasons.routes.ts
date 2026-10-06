import { SeasonFiltersSchema, SeasonSchema, SeasonSortingSchema } from "@reelvault/sdk/common";
import { SeasonIdParams } from "@/api/schemas/route-params";
import { seasonsService } from "@/application/catalog/seasons.service";
import { createCatalogResourceRoutes } from "./shared/create-catalog-resource-routes";

export const seasonsRoutes = createCatalogResourceRoutes({
	prefix: "/seasons",
	tag: "Seasons",
	name: "season",
	service: seasonsService,
	entity: SeasonSchema,
	filters: SeasonFiltersSchema,
	sorting: SeasonSortingSchema,
	params: SeasonIdParams,
	cacheMaxAge: { list: 60, detail: 120 },
	descriptions: {
		list: "Retrieve a paginated list of TV show seasons.",
		detail: "Retrieve detailed information about a specific TV show season by its ID.",
	},
});
