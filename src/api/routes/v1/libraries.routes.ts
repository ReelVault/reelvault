import {
	CreateLibrarySchema,
	LibraryDetailSchema,
	LibraryErrorsCheckRequestSchema,
	LibraryFiltersSchema,
	LibrarySortingSchema,
	LibraryWithRelationsSchema,
	OperationQueuedResponseSchema,
	ProjectedResponseSchema,
	UpdateLibrarySchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, FieldsSchema, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { LibraryIdParams } from "@/api/schemas/route-params";
import { librariesService } from "@/application/libraries/libraries.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { sidecarAssetsService } from "@/modules/metadata-sidecars/sidecar-assets.service";
import { MINUTE } from "@/server.constants";

export const librariesRoutes = new Elysia({
	prefix: "/libraries",
	tags: ["Libraries"],
})
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.model({
		"library.schema": ProjectedResponseSchema(LibraryDetailSchema),
		"libraries.paginated.schema": PaginatedResponseSchema(ProjectedResponseSchema(LibraryWithRelationsSchema)),
		"libraries.create.body": CreateLibrarySchema,
		"libraries.update.body": UpdateLibrarySchema,
		"libraries.checkErrors.body": LibraryErrorsCheckRequestSchema,
	})
	.guard({ auth: true })
	.post(
		"/check-errors",
		async ({ body, status, user, request }) =>
			status(202, await librariesService.checkErrors(body.libraryPaths, { actorUserId: user?.id, headers: request.headers })),
		{
			adminOnly: true,
			rateLimit: {
				name: "library-errors-check",
				max: 1,
				windowMs: 5 * MINUTE,
			},
			body: "libraries.checkErrors.body",
			response: { ...ROUTE_ERRORS.ADMIN, 202: OperationQueuedResponseSchema },
			detail: {
				description: "Queue an FFmpeg decode-error check for the supplied library paths.",
			},
		},
	)
	.get("/", async ({ query }) => await librariesService.getAll(query), {
		query: t.Composite([PaginationSchema, FieldsSchema, LibraryFiltersSchema, LibrarySortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "libraries.paginated.schema" },
		// Home-screen staple; stats/paths already have 60 s server caches, this
		// trims repeat HTTP work. Library mutations bust it via the short TTL.
		cache: { maxAge: 15, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve a paginated list of all media libraries defined in the system.",
		},
	})
	.post(
		"/",
		async ({ body, query, user, request }) =>
			await librariesService.create(body, query, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			body: "libraries.create.body",
			query: "fields.schema",
			response: { ...ROUTE_ERRORS.VALIDATED, 201: "library.schema" },
			detail: {
				description: "Add a new media library with specified paths and content type.",
			},
		},
	)
	.get(
		"/:libraryId",
		async ({ params, query }) => await librariesService.getById(params.libraryId, query, { siblings: query.siblings === "true" }),
		{
			params: t.Object({
				libraryId: t.String(),
			}),
			query: t.Composite([t.Object({ siblings: t.Optional(t.String()) }), t.Object({ fields: t.Optional(t.String()) })]),
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "library.schema" },
			cache: { maxAge: 15, private: true },
			deduplicate: {},
			detail: {
				description: "Retrieve information about a specific library by its ID. Add ?siblings=true to include all libraries.",
			},
		},
	)
	.get("/:libraryId/metadata-sidecars/assets", async ({ params }) => await sidecarAssetsService.getIgnoredAssets(params.libraryId), {
		// Full recursive directory walk over every library root — admin tooling.
		adminOnly: true,
		rateLimit: { name: "library-sidecar-assets", max: 10, windowMs: MINUTE },
		params: LibraryIdParams,
		response: {
			...ROUTE_ERRORS.ADMIN_NOT_FOUND,
			200: t.Array(t.Object({ path: t.String(), fileName: t.String(), reason: t.String() })),
		},
		detail: { description: "List ignored local sidecar assets inside configured library roots." },
	})
	.get("/:libraryId/scan-findings", async ({ params }) => ({ items: await librariesService.getScanFindings(params.libraryId) }), {
		adminOnly: true,
		rateLimit: { name: "library-scan-findings", max: 30, windowMs: MINUTE },
		params: LibraryIdParams,
		response: {
			...ROUTE_ERRORS.ADMIN_NOT_FOUND,
			200: t.Object({
				items: t.Array(t.Object({ filePath: t.String(), fileName: t.String(), reason: t.String() })),
			}),
		},
		detail: {
			description: "List files the latest scan could not ingest (unknown structure, library type mismatch, no metadata match).",
		},
	})
	.patch(
		"/:libraryId",
		async ({ params, body, query, user, request }) =>
			await librariesService.update(params.libraryId, body, query, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			params: t.Object({
				libraryId: t.String(),
			}),
			body: "libraries.update.body",
			query: "fields.schema",
			response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: "library.schema" },
			detail: {
				description: "Modify an existing library's name or paths.",
			},
		},
	)
	.delete(
		"/:libraryId",
		async ({ params, user, request }) =>
			await librariesService.delete(params.libraryId, { actorUserId: user?.id, headers: request.headers }),
		{
			adminOnly: true,
			params: t.Object({
				libraryId: t.String(),
			}),
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "success.response" },
			detail: {
				description: "Permanently remove a library and its configuration from the system.",
			},
		},
	)
	.post(
		"/:libraryId/scan",
		async ({ params, status, user, request }) =>
			status(202, await librariesService.scan(params.libraryId, { actorUserId: user?.id, headers: request.headers })),
		{
			adminOnly: true,
			rateLimit: {
				name: "library-scan",
				max: 30,
				windowMs: MINUTE,
			},
			params: t.Object({
				libraryId: t.String(),
			}),
			response: { ...ROUTE_ERRORS.NOT_FOUND, 202: OperationQueuedResponseSchema },
			detail: {
				description: "Manually trigger a scan of the library's paths to discover new media files.",
			},
		},
	)
	.post(
		"/:libraryId/paths/:pathId/scan",
		async ({ params, status, user, request }) =>
			status(202, await librariesService.scanPath(params.libraryId, params.pathId, { actorUserId: user?.id, headers: request.headers })),
		{
			adminOnly: true,
			rateLimit: {
				name: "library-scan",
				max: 30,
				windowMs: MINUTE,
			},
			params: t.Object({
				libraryId: t.String(),
				pathId: t.String(),
			}),
			response: { ...ROUTE_ERRORS.NOT_FOUND, 202: OperationQueuedResponseSchema },
			detail: {
				description: "Manually trigger a scan of one configured library path.",
			},
		},
	);
