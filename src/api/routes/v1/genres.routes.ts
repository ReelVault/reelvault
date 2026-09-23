import { ProjectedResponseSchema } from "@sdk/common";
import { GenreFiltersSchema, GenreSchema, GenreSortingSchema } from "@sdk/common/genre.types";
import { Elysia, t } from "elysia";
import { commonModel, FieldsSchema, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { genresService } from "@/application/catalog/genres.service";
import { authMiddleware } from "@/middleware/auth.middleware";

export const genreRoutes = new Elysia({
	prefix: "/genres",
	tags: ["Genres"],
})
	.use(commonModel)
	.use(authMiddleware)
	.model({
		"genre.schema": ProjectedResponseSchema(GenreSchema),
		"genres.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(GenreSchema)),
	})
	.guard({ auth: true })
	.get("/", async ({ query }) => await genresService.getAll(query), {
		query: t.Composite([PaginationSchema, FieldsSchema, GenreFiltersSchema, GenreSortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "genres.paginated.schema" },
		cache: { maxAge: 120, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve a paginated list of all movie and TV show genres.",
		},
	})
	.get("/:genreId", async ({ params, query }) => await genresService.getById(params.genreId, query), {
		params: t.Object({
			genreId: t.String(),
		}),
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "genre.schema" },
		cache: { maxAge: 120, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve information about a specific genre by its ID.",
		},
	});
