import { ProjectedResponseSchema } from "@sdk/common";
import { KeywordFiltersSchema, KeywordSchema, KeywordSortingSchema } from "@sdk/common/keyword.types";
import { Elysia, t } from "elysia";
import { commonModel, FieldsSchema, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { keywordsService } from "@/application/catalog/keywords.service";
import { authMiddleware } from "@/middleware/auth.middleware";

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
		cache: { maxAge: 120, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve a paginated list of all keywords used for metadata tagging.",
		},
	})
	.get("/:keywordId", async ({ params, query }) => await keywordsService.getById(params.keywordId, query), {
		params: t.Object({
			keywordId: t.String(),
		}),
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "keyword.schema" },
		cache: { maxAge: 120, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve information about a specific keyword by its ID.",
		},
	});
