import { CompanyFiltersSchema, CompanySchema, CompanySortingSchema, MetadataSchema, ProjectedResponseSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import {
	ClampedNumeric,
	commonModel,
	FieldsSchema,
	PaginatedResponseSchema,
	PaginationSchema,
	ROUTE_ERRORS,
} from "@/api/schemas/common.schemas";
import { CompanyIdParams } from "@/api/schemas/route-params";
import { companiesService } from "@/application/catalog/companies.service";
import { authMiddleware } from "@/middleware/auth.middleware";

export const companiesRoutes = new Elysia({
	prefix: "/companies",
	tags: ["Companies"],
})
	.use(commonModel)
	.use(authMiddleware)
	.model({
		"company.schema": ProjectedResponseSchema(CompanySchema),
		"companies.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(CompanySchema)),
	})
	.guard({ auth: true })
	.get("/", async ({ query }) => await companiesService.getAll(query), {
		query: t.Composite([PaginationSchema, FieldsSchema, CompanyFiltersSchema, CompanySortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "companies.paginated.schema" },
		cache: { maxAge: 120, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve a paginated list of all production companies.",
		},
	})
	.get("/:companyId/metadata", async ({ params, query }) => await companiesService.getMetadata(params.companyId, query.limit), {
		params: CompanyIdParams,
		query: t.Object({ limit: t.Optional(ClampedNumeric(1, 100)) }),
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: t.Array(MetadataSchema) },
		cache: { maxAge: 60, private: true },
		deduplicate: {},
		detail: { description: "List catalog titles associated with a production company." },
	})
	.get("/:companyId", async ({ params, query }) => await companiesService.getById(params.companyId, query), {
		params: t.Object({
			companyId: t.String(),
		}),
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "company.schema" },
		cache: { maxAge: 120, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve information about a specific production company by its ID.",
		},
	});
