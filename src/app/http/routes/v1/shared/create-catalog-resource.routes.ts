import { BulkRefreshBodySchema, type BulkRefreshResult, BulkRefreshResultSchema, ProjectedResponseSchema } from "@reelvault/sdk/common";
import type { Static, TObject, TSchema, TString } from "@sinclair/typebox";
import { Elysia } from "elysia";
import { authMiddleware } from "@/app/http/middleware/auth.middleware";
import { routeLimit } from "@/app/http/middleware/rate-limit.middleware";
import { cached } from "@/app/http/middleware/response-cache.middleware";
import {
	commonModel,
	type FieldsSchema,
	listQuerySchema,
	PaginatedResponseSchema,
	type PaginationSchema,
	ROUTE_ERRORS,
} from "@/app/http/schemas/common.schema";

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

/** The on-demand refresh routes of a catalog resource. */
export interface CatalogResourceRefresh {
	/** Refreshes one entity by id. */
	refresh: (id: string) => Promise<unknown>;
	/** Forces a fresh thumbnail for one entity. */
	refreshImage: (id: string) => Promise<unknown>;
	/** Refreshes many entities, one by one. */
	refreshMany: (ids: string[]) => Promise<BulkRefreshResult>;
	/** The route descriptions, which name the resource in prose. */
	descriptions: { refresh: string; refreshImage: string; refreshMany: string };
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
			query: listQuerySchema({ filters: options.filters, sorting: options.sorting }),
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

/**
 * The same shape plus the on-demand refresh routes, for the resources whose
 * metadata can be refreshed from the admin panel.
 */
export function createRefreshableCatalogResourceRoutes<TFilters extends TSchema, TSorting extends TSchema>(
	options: CatalogResourceRoutesOptions<TFilters, TSorting> & { refresh: CatalogResourceRefresh },
) {
	const paramKey = `${options.name}Id`;
	const detailModel = `${options.name}.schema`;
	const { refresh, refreshImage, refreshMany, descriptions } = options.refresh;

	return createCatalogResourceRoutes(options)
		.post(`/:${paramKey}/refresh`, async ({ params }) => await refresh(params[paramKey] ?? ""), {
			adminOnly: true,
			rateLimit: routeLimit(`${options.name}-refresh`, 30),
			params: options.params,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: detailModel },
			detail: { description: descriptions.refresh },
		})
		.post(`/:${paramKey}/refresh-image`, async ({ params }) => await refreshImage(params[paramKey] ?? ""), {
			adminOnly: true,
			rateLimit: routeLimit(`${options.name}-refresh-image`, 30),
			params: options.params,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: detailModel },
			detail: { description: descriptions.refreshImage },
		})
		.post("/bulk-refresh", async ({ body }) => await refreshMany(body.ids), {
			adminOnly: true,
			rateLimit: routeLimit(`${options.name}-bulk-refresh`, 30),
			body: BulkRefreshBodySchema,
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 200: BulkRefreshResultSchema },
			detail: { description: descriptions.refreshMany },
		});
}
