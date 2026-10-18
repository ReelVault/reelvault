import { SeasonFiltersSchema, SeasonSchema, SeasonSortingSchema } from "@reelvault/sdk/common";
import { seasonsService } from "@/app/catalog/seasons.service";
import { SeasonIdParams } from "@/app/http/schemas/route-params.schema";
import { createCatalogResourceRoutes } from "./shared/create-catalog-resource.routes";

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
