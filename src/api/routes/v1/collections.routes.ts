import {
	CollectionFiltersSchema,
	CollectionSortingSchema,
	CollectionWithRelationsSchema,
	ProjectedResponseSchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, FieldsSchema, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { collectionsService } from "@/application/catalog/collections.service";
import { authMiddleware } from "@/middleware/auth.middleware";

export const collectionRoutes = new Elysia({
	prefix: "/collections",
	tags: ["Collections"],
})
	.use(commonModel)
	.use(authMiddleware)
	.model({
		"collection.schema": ProjectedResponseSchema(CollectionWithRelationsSchema),
		"collections.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(CollectionWithRelationsSchema)),
	})
	.guard({ auth: true })
	.get("/", async ({ query }) => await collectionsService.getAll(query), {
		query: t.Composite([PaginationSchema, FieldsSchema, CollectionFiltersSchema, CollectionSortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "collections.paginated.schema" },
		cache: { maxAge: 120, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve a paginated list of collections. By default, collections with fewer than two metadata items are excluded.",
		},
	})
	.get("/:collectionId", async ({ params, query }) => await collectionsService.getById(params.collectionId, query), {
		params: t.Object({
			collectionId: t.String(),
		}),
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "collection.schema" },
		cache: { maxAge: 120, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve information about a specific collection by its ID.",
		},
	});
