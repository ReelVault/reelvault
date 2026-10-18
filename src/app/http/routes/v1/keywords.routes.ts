import { KeywordFiltersSchema, KeywordSchema, KeywordSortingSchema } from "@reelvault/sdk/common";
import { keywordsService } from "@/app/catalog/keywords.service";
import { KeywordIdParams } from "@/app/http/schemas/route-params.schema";
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
