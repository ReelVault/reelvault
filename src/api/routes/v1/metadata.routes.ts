import {
	CreateMetadataSchema,
	GlobalSearchResponseSchema,
	LinkMetadataProviderSchema,
	MetadataDetailsViewResponseSchema,
	MetadataFiltersSchema,
	MetadataImageOptionSchema,
	MetadataImageTypeSchema,
	MetadataSortingSchema,
	MetadataWithRelationSchema,
	ProjectedResponseSchema,
	RematchMetadataSchema,
	SelectMetadataImageSchema,
	SuccessResponseSchema,
	UpdateMetadataSchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import {
	ClampedNumeric,
	commonModel,
	FieldsSchema,
	PaginatedResponseSchema,
	PaginationSchema,
	ROUTE_ERRORS,
} from "@/api/schemas/common.schemas";
import { MetadataIdParams } from "@/api/schemas/route-params";
import { withEtagResponse } from "@/api/utils/etag.utils";
import { metadataService } from "@/application/catalog/metadata/metadata.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { MINUTE } from "@/server.constants";

const GlobalSearchQuerySchema = t.Object({
	q: t.String({ minLength: 2, maxLength: 200 }),
	limit: t.Optional(ClampedNumeric(1, 20)),
});

export const metadataRoutes = new Elysia({
	prefix: "/metadata",
	tags: ["Metadata"],
})
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.model({
		"metadata.schema": ProjectedResponseSchema(MetadataWithRelationSchema),
		"metadata.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(MetadataWithRelationSchema)),
		"metadata.details-view": MetadataDetailsViewResponseSchema,
		"metadata.create.body": CreateMetadataSchema,
		"metadata.update.body": UpdateMetadataSchema,
	})
	.guard({ auth: true })
	.get("/", async ({ query, profile }) => await metadataService.getAll(query, profile?.id), {
		query: t.Composite([PaginationSchema, FieldsSchema, MetadataFiltersSchema, MetadataSortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "metadata.paginated.schema" },
		cache: { maxAge: 60, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve a paginated list of metadata entries for movies and TV shows with advanced filtering.",
		},
	})
	.get("/search/global", async ({ query }) => await metadataService.searchGlobal(query.q, query.limit), {
		rateLimit: {
			name: "metadata-global-search",
			max: 60,
			windowMs: MINUTE,
		},
		cache: { maxAge: 30, private: true },
		deduplicate: {},
		query: GlobalSearchQuerySchema,
		response: { ...ROUTE_ERRORS.AUTH, 200: GlobalSearchResponseSchema },
		detail: {
			description: "Search titles, people, collections and genres in one request.",
		},
	})
	.post(
		"/",
		async ({ body, query, user, request }) =>
			await metadataService.create(body, query, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			body: "metadata.create.body",
			query: "fields.schema",
			response: { ...ROUTE_ERRORS.VALIDATED, 201: "metadata.schema" },
			detail: {
				description: "Add a new metadata entry to the system.",
			},
		},
	)
	.get("/:metadataId/images/options", async ({ params }) => await metadataService.getImageOptions(params.metadataId), {
		params: MetadataIdParams,
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: t.Array(MetadataImageOptionSchema) },
		cache: { maxAge: 300, private: true },
		deduplicate: {},
		detail: { description: "Retrieve poster and backdrop candidates from linked metadata providers." },
	})
	.post(
		"/:metadataId/images/select",
		async ({ params, body, user, request }) =>
			await metadataService.selectImage(params.metadataId, body, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			params: MetadataIdParams,
			body: SelectMetadataImageSchema,
			response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: SuccessResponseSchema },
			detail: { description: "Select and download a poster or backdrop candidate." },
		},
	)
	.post(
		"/:metadataId/images/upload",
		async ({ params, body, user, request }) =>
			await metadataService.uploadImage(params.metadataId, body.type, body.file, {
				actorUserId: user?.id,
				headers: request.headers,
			}),
		{
			adminOnly: true,
			params: MetadataIdParams,
			body: t.Object({
				type: MetadataImageTypeSchema,
				file: t.File({ type: "image/*", maxSize: "20m" }),
			}),
			response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: SuccessResponseSchema },
			detail: { description: "Upload, optimize and activate a custom poster or backdrop." },
		},
	)
	.get(
		"/:metadataId/details-view",
		async ({ params, profile, request, set }) =>
			withEtagResponse(request, set, () => metadataService.getDetailsView(params.metadataId, profile?.id), {
				// The details view runs ~17 queries; the cacheKey makes a repeat/304
				// request skip the whole aggregation (cleared on metadata writes).
				cacheKey: `metadata-details:${params.metadataId}:${profile?.id ?? "anon"}`,
			}),
		{
			params: MetadataIdParams,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "metadata.details-view" },
			deduplicate: {},
			detail: {
				description:
					"Get full aggregated view of title metadata, seasons/episodes, media files, and active profile user state in one request.",
			},
		},
	)
	.get("/:metadataId", async ({ params, query }) => await metadataService.getById(params.metadataId, query), {
		params: MetadataIdParams,
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "metadata.schema" },
		cache: { maxAge: 120, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve detailed information about a specific metadata entry by its ID.",
		},
	})
	.patch(
		"/:metadataId",
		async ({ params, body, query, user, request }) =>
			await metadataService.update(params.metadataId, body, query, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			params: MetadataIdParams,
			body: "metadata.update.body",
			query: "fields.schema",
			response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: "metadata.schema" },
			detail: {
				description: "Modify an existing metadata entry's details.",
			},
		},
	)
	.post(
		"/:metadataId/providers",
		async ({ params, body, query, user, request }) =>
			await metadataService.linkProvider(params.metadataId, body, query, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			params: MetadataIdParams,
			body: LinkMetadataProviderSchema,
			query: "fields.schema",
			response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: "metadata.schema" },
			detail: {
				description: "Link an additional metadata provider and re-aggregate fields by priority.",
			},
		},
	)
	.post(
		"/:metadataId/rematch",
		async ({ params, body, query, user, request }) =>
			await metadataService.rematch(params.metadataId, body, query, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			params: MetadataIdParams,
			body: RematchMetadataSchema,
			query: "fields.schema",
			response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: "metadata.schema" },
			detail: {
				description: "Rematch metadata entry with a specific provider search result.",
			},
		},
	)
	.delete(
		"/:metadataId",
		async ({ params, user, request }) =>
			await metadataService.delete(params.metadataId, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			params: MetadataIdParams,
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "success.response" },
			detail: {
				description: "Permanently remove a metadata entry from the system.",
			},
		},
	)
	.post(
		"/:metadataId/merge",
		async ({ params, body, user, request }) =>
			await metadataService.mergeMetadata(params.metadataId, body.sourceMetadataId, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			params: MetadataIdParams,
			body: t.Object({
				sourceMetadataId: t.String(),
			}),
			response: {
				...ROUTE_ERRORS.VALIDATED_NOT_FOUND,
				200: t.Object({
					success: t.Literal(true),
					targetId: t.String(),
				}),
			},
			detail: {
				description: "Merge another metadata entry into this one.",
			},
		},
	)
	.get("/:metadataId/similar", async ({ params, query }) => await metadataService.getSimilar(params.metadataId, query), {
		params: MetadataIdParams,
		query: t.Composite([PaginationSchema, FieldsSchema]),
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "metadata.paginated.schema" },
		cache: { maxAge: 60, private: true },
		detail: {
			description: "Retrieve a list of metadata entries similar to the specified one, based on various shared attributes.",
		},
	})
	.post(
		"/:metadataId/refresh-images",
		async ({ params, body }) => await metadataService.refreshImages(params.metadataId, { force: body?.force ?? true }),
		{
			adminOnly: true,
			params: MetadataIdParams,
			body: t.Optional(
				t.Object({
					force: t.Optional(t.Boolean()),
				}),
			),
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: SuccessResponseSchema },
			detail: {
				description: "Force download and refresh posters, backdrops, and child images from linked provider.",
			},
		},
	);
