import { GenreFiltersSchema, GenreSchema, GenreSortingSchema } from "@reelvault/sdk/common";
import { GenreIdParams } from "@/api/schemas/route-params.schema";
import { genresService } from "@/services/catalog/genres.service";
import { createCatalogResourceRoutes } from "./shared/create-catalog-resource.routes";

export const genreRoutes = createCatalogResourceRoutes({
	prefix: "/genres",
	tag: "Genres",
	name: "genre",
	service: genresService,
	entity: GenreSchema,
	filters: GenreFiltersSchema,
	sorting: GenreSortingSchema,
	params: GenreIdParams,
	cacheMaxAge: { list: 120, detail: 120 },
	descriptions: {
		list: "Retrieve a paginated list of all movie and TV show genres.",
		detail: "Retrieve information about a specific genre by its ID.",
	},
});
