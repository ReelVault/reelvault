import { CompanyFiltersSchema, CompanySchema, CompanySortingSchema, MetadataSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { companiesService } from "@/app/catalog/companies.service";
import { cached } from "@/app/http/middleware/response-cache.middleware";
import { ClampedNumeric, ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { CompanyIdParams } from "@/app/http/schemas/route-params.schema";
import { createCatalogResourceRoutes } from "./shared/create-catalog-resource.routes";

export const companiesRoutes = createCatalogResourceRoutes({
	prefix: "/companies",
	tag: "Companies",
	name: "company",
	service: companiesService,
	entity: CompanySchema,
	filters: CompanyFiltersSchema,
	sorting: CompanySortingSchema,
	params: CompanyIdParams,
	cacheMaxAge: { list: 120, detail: 120 },
	descriptions: {
		list: "Retrieve a paginated list of all production companies.",
		detail: "Retrieve information about a specific production company by its ID.",
	},
}).get("/:companyId/metadata", async ({ params, query }) => await companiesService.getMetadata(params.companyId, query.limit), {
	params: CompanyIdParams,
	query: t.Object({ limit: t.Optional(ClampedNumeric(1, 100)) }),
	response: { ...ROUTE_ERRORS.NOT_FOUND, 200: t.Array(MetadataSchema) },
	...cached({ maxAge: 60, private: true }),
	detail: { description: "List catalog titles associated with a production company." },
});
