import { KeywordFiltersSchema, KeywordSchema, KeywordSortingSchema, ProjectedResponseSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, FieldsSchema, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { KeywordIdParams } from "@/api/schemas/route-params";
import { keywordsService } from "@/application/catalog/keywords.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { cached } from "@/middleware/response-cache.middleware";

export const keywordsRoutes = new Elysia({
	prefix: "/keywords",
	tags: ["Keywords"],
})
	.use(commonModel)
	.use(authMiddleware)
	.model({
		"keyword.schema": ProjectedResponseSchema(KeywordSchema),
		"keywords.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(KeywordSchema)),
	})
	.guard({ auth: true })
	.get("/", async ({ query }) => await keywordsService.getAll(query), {
		query: t.Composite([PaginationSchema, FieldsSchema, KeywordFiltersSchema, KeywordSortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "keywords.paginated.schema" },
		...cached({ maxAge: 120, private: true }),
		detail: {
			description: "Retrieve a paginated list of all keywords used for metadata tagging.",
		},
	})
	.get("/:keywordId", async ({ params, query }) => await keywordsService.getById(params.keywordId, query), {
		params: KeywordIdParams,
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "keyword.schema" },
		...cached({ maxAge: 120, private: true }),
		detail: {
			description: "Retrieve information about a specific keyword by its ID.",
		},
	});
