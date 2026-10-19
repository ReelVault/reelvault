import {
	CreateLibrarySchema,
	LibraryDetailSchema,
	LibraryErrorsCheckRequestSchema,
	LibraryErrorsCheckStatusSchema,
	LibraryFiltersSchema,
	LibraryHealthResponseSchema,
	LibraryScanAllResponseSchema,
	LibraryScanCancelResponseSchema,
	LibraryScanProgressResponseSchema,
	LibrarySortingSchema,
	LibraryWithRelationsSchema,
	OperationQueuedResponseSchema,
	ProjectedResponseSchema,
	ScanFindingCandidatesResponseSchema,
	ScanFindingIgnoredResponseSchema,
	ScanFindingStatusSchema,
	ScanFindingsResponseSchema,
	UpdateLibrarySchema,
	UpdateScanFindingSchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { authMiddleware } from "@/app/http/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/app/http/middleware/rate-limit.middleware";
import { cached } from "@/app/http/middleware/response-cache.middleware";
import { commonModel, FieldsSchema, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { LibraryIdParams, OperationIdParams } from "@/app/http/schemas/route-params.schema";
import { actorContext } from "@/app/http/utils/audit-context.utils";
import { librariesService } from "@/app/libraries/libraries.service";
import { MINUTE } from "@/config/server/server.constants";
import { sidecarAssetsService } from "@/modules/metadata-sidecars/sidecar-assets.service";

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
		"libraries.scanFinding.update.body": UpdateScanFindingSchema,
	})
	.guard({ auth: true })
	.post(
		"/check-errors",
		async ({ body, status, user, request }) =>
			status(202, await librariesService.checkErrors(body.libraryPaths, actorContext({ user, request }))),
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
	.get("/scan-progress", async () => await librariesService.getScanProgress(), {
		adminOnly: true,
		rateLimit: { name: "library-scan-progress", max: 120, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: LibraryScanProgressResponseSchema },
		detail: {
			description:
				"Each library with a queued or running scan and its progress. The percent is null while the scan discovers files; afterwards it is the share of the enqueued work already handed to the queues.",
		},
	})
	.get("/health", async () => await librariesService.getHealth(), {
		adminOnly: true,
		rateLimit: { name: "library-health", max: 30, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 200: LibraryHealthResponseSchema },
		detail: {
			description:
				"Each library's paths as they are now: whether the path exists on disk, whether the filesystem watcher covers it, and when the library was last scanned.",
		},
	})
	.get("/check-errors/:operationId", async ({ params }) => await librariesService.getErrorsCheckStatus(params.operationId), {
		adminOnly: true,
		rateLimit: { name: "library-errors-check-status", max: 120, windowMs: MINUTE },
		params: OperationIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: LibraryErrorsCheckStatusSchema },
		detail: {
			description: "Status of a check queued by POST /libraries/check-errors. The result is set once the check has completed.",
		},
	})
	.get("/", async ({ query }) => await librariesService.getAll(query), {
		query: t.Composite([PaginationSchema, FieldsSchema, LibraryFiltersSchema, LibrarySortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "libraries.paginated.schema" },
		// Home-screen staple; stats/paths already have 60 s server caches, this
		// trims repeat HTTP work. Library mutations bust it via the short TTL.
		...cached({ maxAge: 15, private: true }),
		detail: {
			description: "Retrieve a paginated list of all media libraries defined in the system.",
		},
	})
	.post("/", async ({ body, query, user, request }) => await librariesService.create(body, query, actorContext({ user, request })), {
		adminOnly: true,
		body: "libraries.create.body",
		query: "fields.schema",
		response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 201: "library.schema" },
		detail: {
			description: "Add a new media library with specified paths and content type.",
		},
	})
	.get(
		"/:libraryId",
		async ({ params, query }) => await librariesService.getById(params.libraryId, query, { siblings: query.siblings === true }),
		{
			params: LibraryIdParams,
			query: t.Composite([t.Object({ siblings: t.Optional(t.BooleanString()) }), FieldsSchema]),
			response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "library.schema" },
			...cached({ maxAge: 15, private: true }),
			detail: {
				description: "Retrieve information about a specific library by its ID. Add ?siblings=true to include all libraries.",
			},
		},
	)
	.post("/scan", async ({ status, user, request }) => status(202, await librariesService.scanAll(actorContext({ user, request }))), {
		adminOnly: true,
		rateLimit: { name: "library-scan-all", max: 10, windowMs: MINUTE },
		response: { ...ROUTE_ERRORS.ADMIN, 202: LibraryScanAllResponseSchema },
		detail: {
			description: "Queue a scan of every library. The scans run one after another, in library order.",
		},
	})
	.post(
		"/:libraryId/scan/cancel",
		async ({ params, user, request }) => await librariesService.cancelScans(params.libraryId, actorContext({ user, request })),
		{
			adminOnly: true,
			rateLimit: { name: "library-scan-cancel", max: 30, windowMs: MINUTE },
			params: LibraryIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: LibraryScanCancelResponseSchema },
			detail: {
				description:
					"Cancel the queued and running scans of a library, including its path scans and catch-up passes. A later scan of the library picks up from the checkpoint this one left behind.",
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
	.get("/:libraryId/scan-findings", async ({ params, query }) => await librariesService.getScanFindings(params.libraryId, query.status), {
		adminOnly: true,
		rateLimit: { name: "library-scan-findings", max: 30, windowMs: MINUTE },
		params: LibraryIdParams,
		query: t.Object({ status: t.Optional(ScanFindingStatusSchema) }),
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: ScanFindingsResponseSchema },
		detail: {
			description:
				"List files the scans could not ingest (unknown structure, library type mismatch, no metadata match) in one status, active by default. `counts` covers both statuses.",
		},
	})
	.patch(
		"/:libraryId/scan-findings",
		async ({ params, body, user, request }) =>
			await librariesService.setScanFindingIgnored(params.libraryId, body.filePath, body.ignored, {
				actorUserId: user?.id,
				headers: request.headers,
			}),
		{
			adminOnly: true,
			rateLimit: { name: "library-scan-finding-update", max: 120, windowMs: MINUTE },
			params: LibraryIdParams,
			body: "libraries.scanFinding.update.body",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: ScanFindingIgnoredResponseSchema },
			detail: {
				description:
					"Ignore a scan finding until it is restored. An ignored finding stays ignored through later scans; `ignored: false` restores it.",
			},
		},
	)
	.get(
		"/:libraryId/scan-findings/candidates",
		async ({ params, query }) => await librariesService.getScanFindingCandidates(params.libraryId, query.filePath),
		{
			adminOnly: true,
			rateLimit: { name: "library-scan-finding-candidates", max: 20, windowMs: MINUTE },
			params: LibraryIdParams,
			query: t.Object({ filePath: t.String({ minLength: 1 }) }),
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: ScanFindingCandidatesResponseSchema },
			detail: {
				description:
					"Search the metadata providers for the title parsed from a finding's file name. Runs only when requested, never during a scan.",
			},
		},
	)
	.patch(
		"/:libraryId",
		async ({ params, body, query, user, request }) =>
			await librariesService.update(params.libraryId, body, query, actorContext({ user, request })),
		{
			adminOnly: true,
			params: LibraryIdParams,
			body: "libraries.update.body",
			query: "fields.schema",
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "library.schema" },
			detail: {
				description: "Modify an existing library's name or paths.",
			},
		},
	)
	.delete(
		"/:libraryId",
		async ({ params, user, request }) => await librariesService.delete(params.libraryId, actorContext({ user, request })),
		{
			adminOnly: true,
			params: LibraryIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "success.response" },
			detail: {
				description: "Permanently remove a library and its configuration from the system.",
			},
		},
	)
	.post(
		"/:libraryId/scan",
		async ({ params, status, user, request }) =>
			status(202, await librariesService.scan(params.libraryId, actorContext({ user, request }))),
		{
			adminOnly: true,
			rateLimit: {
				name: "library-scan",
				max: 30,
				windowMs: MINUTE,
			},
			params: LibraryIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 202: OperationQueuedResponseSchema },
			detail: {
				description: "Manually trigger a scan of the library's paths to discover new media files.",
			},
		},
	)
	.post(
		"/:libraryId/paths/:pathId/scan",
		async ({ params, status, user, request }) =>
			status(202, await librariesService.scanPath(params.libraryId, params.pathId, actorContext({ user, request }))),
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
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 202: OperationQueuedResponseSchema },
			detail: {
				description: "Manually trigger a scan of one configured library path.",
			},
		},
	);
