import { ProjectedResponseSchema } from "@reelvault/sdk/common";
import type { Static, TObject, TSchema, TString } from "@sinclair/typebox";
import { Elysia, t } from "elysia";
import { commonModel, FieldsSchema, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { authMiddleware } from "@/middleware/auth.middleware";
import { cached } from "@/middleware/response-cache.middleware";

/**
 * Shared route shape for the single-id catalog resources (genres, keywords,
 * seasons, collections, companies, people, episodes): authenticated paginated
 * list + projected detail, both served through the response cache. Callers add
 * their extra admin routes as chained `.post()`/`.get()` calls — the returned
 * instance already carries the auth guard.
 */

type CatalogListQuery<TFilters extends TSchema, TSorting extends TSchema> = Static<typeof PaginationSchema> &
	Static<typeof FieldsSchema> &
	Static<TFilters> &
	Static<TSorting>;

interface CatalogResourceService<TFilters extends TSchema, TSorting extends TSchema> {
	getAll(query: CatalogListQuery<TFilters, TSorting>): Promise<unknown>;
	getById(id: string, query: Static<typeof FieldsSchema>): Promise<unknown>;
}

export interface CatalogResourceRoutesOptions<TFilters extends TSchema, TSorting extends TSchema> {
	prefix: string;
	tag: string;
	/** Singular model stem: `genre` → `genre.schema` + `genres.paginated.schema`. */
	name: string;
	service: CatalogResourceService<TFilters, TSorting>;
	entity: TSchema;
	filters: TFilters;
	sorting: TSorting;
	params: TObject<Record<string, TString>>;
	cacheMaxAge: { list: number; detail: number };
	descriptions: { list: string; detail: string };
}

export function createCatalogResourceRoutes<TFilters extends TSchema, TSorting extends TSchema>(
	options: CatalogResourceRoutesOptions<TFilters, TSorting>,
) {
	const paramKey = `${options.name}Id`;
	const detailModel = `${options.name}.schema`;
	const paginatedModel = `${options.prefix.slice(1)}.paginated.schema`;

	return new Elysia({ prefix: options.prefix, tags: [options.tag] })
		.use(commonModel)
		.use(authMiddleware)
		.model({
			[detailModel]: ProjectedResponseSchema(options.entity),
			[paginatedModel]: PaginatedResponseSchema(ProjectedResponseSchema(options.entity)),
		})
		.guard({ auth: true })
		.get("/", async ({ query }) => await options.service.getAll(query), {
			query: t.Composite([PaginationSchema, FieldsSchema, options.filters, options.sorting]),
			response: { ...ROUTE_ERRORS.AUTH, 200: paginatedModel },
			...cached({ maxAge: options.cacheMaxAge.list, private: true }),
			detail: { description: options.descriptions.list },
		})
		.get(`/:${paramKey}`, async ({ params, query }) => await options.service.getById(params[paramKey] ?? "", query), {
			params: options.params,
			query: "fields.schema",
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: detailModel },
			...cached({ maxAge: options.cacheMaxAge.detail, private: true }),
			detail: { description: options.descriptions.detail },
		});
}
