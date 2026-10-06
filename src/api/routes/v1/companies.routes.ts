import { CompanyFiltersSchema, CompanySchema, CompanySortingSchema, MetadataSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { ClampedNumeric, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { CompanyIdParams } from "@/api/schemas/route-params";
import { companiesService } from "@/application/catalog/companies.service";
import { cached } from "@/middleware/response-cache.middleware";
import { createCatalogResourceRoutes } from "./shared/create-catalog-resource-routes";

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
