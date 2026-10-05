import { PersonFiltersSchema, PersonSortingSchema, PersonWithRelationsSchema, ProjectedResponseSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, FieldsSchema, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { PersonIdParams } from "@/api/schemas/route-params";
import { peopleService } from "@/application/catalog/people.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { cached } from "@/middleware/response-cache.middleware";
import { MINUTE } from "@/server.constants";

export const peopleRoutes = new Elysia({
	prefix: "/people",
	tags: ["People"],
})
	.use(commonModel)
	.use(authMiddleware)
	.model({
		"person.schema": ProjectedResponseSchema(PersonWithRelationsSchema),
		"people.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(PersonWithRelationsSchema)),
	})
	.guard({ auth: true })
	.get("/", async ({ query }) => await peopleService.getAll(query), {
		query: t.Composite([PaginationSchema, FieldsSchema, PersonFiltersSchema, PersonSortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "people.paginated.schema" },
		...cached({ maxAge: 60, private: true }),
		detail: {
			description: "Retrieve a paginated list of people (cast and crew members).",
		},
	})
	.get("/:personId", async ({ params, query }) => await peopleService.getById(params.personId, query), {
		params: PersonIdParams,
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "person.schema" },
		...cached({ maxAge: 120, private: true }),
		detail: {
			description: "Retrieve detailed information about a specific person by their ID.",
		},
	})
	.post("/:personId/refresh", async ({ params }) => await peopleService.refresh(params.personId), {
		adminOnly: true,
		rateLimit: {
			name: "person-refresh",
			max: 30,
			windowMs: MINUTE,
		},
		params: PersonIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "person.schema" },
		detail: {
			description: "Refresh person details and download profile image if missing.",
		},
	})
	.post("/:personId/refresh-image", async ({ params }) => await peopleService.refreshImage(params.personId), {
		adminOnly: true,
		rateLimit: {
			name: "person-refresh-image",
			max: 30,
			windowMs: MINUTE,
		},
		params: PersonIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "person.schema" },
		detail: {
			description: "Force download and replace person profile image.",
		},
	});
