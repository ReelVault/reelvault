import { ProjectedResponseSchema, SeasonFiltersSchema, SeasonSchema, SeasonSortingSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, FieldsSchema, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { SeasonIdParams } from "@/api/schemas/route-params";
import { seasonsService } from "@/application/catalog/seasons.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { cached } from "@/middleware/response-cache.middleware";

export const seasonsRoutes = new Elysia({
	prefix: "/seasons",
	tags: ["Seasons"],
})
	.use(commonModel)
	.use(authMiddleware)
	.model({
		"season.schema": ProjectedResponseSchema(SeasonSchema),
		"seasons.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(SeasonSchema)),
	})
	.guard({ auth: true })
	.get("/", async ({ query }) => await seasonsService.getAll(query), {
		query: t.Composite([PaginationSchema, FieldsSchema, SeasonFiltersSchema, SeasonSortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "seasons.paginated.schema" },
		...cached({ maxAge: 60, private: true }),
		detail: {
			description: "Retrieve a paginated list of TV show seasons.",
		},
	})
	.get("/:seasonId", async ({ params, query }) => await seasonsService.getById(params.seasonId, query), {
		params: SeasonIdParams,
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "season.schema" },
		...cached({ maxAge: 120, private: true }),
		detail: {
			description: "Retrieve detailed information about a specific TV show season by its ID.",
		},
	});
