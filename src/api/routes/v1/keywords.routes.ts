import { KeywordFiltersSchema, KeywordSchema, KeywordSortingSchema } from "@reelvault/sdk/common";
import { KeywordIdParams } from "@/api/schemas/route-params.schema";
import { keywordsService } from "@/services/catalog/keywords.service";
import { createCatalogResourceRoutes } from "./shared/create-catalog-resource.routes";

export const keywordsRoutes = createCatalogResourceRoutes({
	prefix: "/keywords",
	tag: "Keywords",
	name: "keyword",
	service: keywordsService,
	entity: KeywordSchema,
	filters: KeywordFiltersSchema,
	sorting: KeywordSortingSchema,
	params: KeywordIdParams,
	cacheMaxAge: { list: 120, detail: 120 },
	descriptions: {
		list: "Retrieve a paginated list of all keywords used for metadata tagging.",
		detail: "Retrieve information about a specific keyword by its ID.",
	},
});
