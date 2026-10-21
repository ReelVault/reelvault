import {
	BulkSubtitleDeleteResultSchema,
	BulkSubtitleDeleteSchema,
	CreateSubtitleRequestSchema,
	SubtitleFiltersSchema,
	SubtitleProviderDownloadRequestSchema,
	SubtitleProviderInfoSchema,
	SubtitleProviderSearchRequestSchema,
	SubtitleProviderSearchResponseSchema,
	SubtitleSchema,
	SubtitleSortingSchema,
	UpdateSubtitleRequestSchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { authMiddleware } from "@/api/middleware/auth.middleware";
import { routeLimit } from "@/api/middleware/rate-limit.middleware";
import { cached } from "@/api/middleware/response-cache.middleware";
import { BinaryNotModifiedSchema, commonModel, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schema";
import { IdParams, ProviderIdParams } from "@/api/schemas/route-params.schema";
import { assertRouteMediaAccess } from "@/api/utils/access-context.utils";
import { binaryFileResponse } from "@/api/utils/binary-response.utils";
import { SUBTITLE_UPLOAD_MAX_SIZE } from "@/config/server/server.constants";
import { subtitlesService } from "@/modules/subtitles/subtitles.service";

const SUBTITLE_CACHE_CONTROL = "private, max-age=300";

export const subtitlesRoutes = new Elysia({ prefix: "/subtitles", tags: ["Subtitles"] })
	.use(commonModel)
	.use(authMiddleware)
	.model({
		"subtitle.schema": SubtitleSchema,
		"subtitles.paginated.schema": PaginatedResponseSchema(SubtitleSchema),
		"subtitle.create.body": CreateSubtitleRequestSchema,
		"subtitle.update.body": UpdateSubtitleRequestSchema,
	})
	.guard({ auth: true })
	.get("/providers", async () => await subtitlesService.getProviders(), {
		response: { ...ROUTE_ERRORS.AUTH, 200: t.Array(SubtitleProviderInfoSchema) },
		detail: {
			description: "List installed subtitle providers and whether each one is on.",
		},
	})
	.patch("/providers/:providerId", async ({ params, body }) => await subtitlesService.setProviderEnabled(params.providerId, body.enabled), {
		adminOnly: true,
		params: ProviderIdParams,
		body: t.Object({ enabled: t.Boolean() }),
		response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 200: SubtitleProviderInfoSchema },
		detail: {
			description: "Turn a subtitle provider on or off. An off provider is not searched and cannot be downloaded from.",
		},
	})
	.post("/search", async ({ body }) => await subtitlesService.searchProviders(body), {
		rateLimit: routeLimit("subtitle-search", 30),
		body: SubtitleProviderSearchRequestSchema,
		response: { ...ROUTE_ERRORS.VALIDATED, 200: t.Array(SubtitleProviderSearchResponseSchema) },
		detail: {
			description: "Search installed subtitle providers for a media file.",
		},
	})
	.post(
		"/providers/:providerId/download",
		async ({ params, body }) => await subtitlesService.downloadFromProvider(params.providerId, body),
		{
			adminOnly: true,
			params: ProviderIdParams,
			body: SubtitleProviderDownloadRequestSchema,
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "subtitle.schema" },
			detail: {
				description: "Download a subtitle through an installed provider into core-managed storage.",
			},
		},
	)
	.get("/", async ({ query }) => await subtitlesService.getAll(query), {
		query: t.Composite([PaginationSchema, SubtitleFiltersSchema, SubtitleSortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "subtitles.paginated.schema" },
		...cached({ maxAge: 60, private: true }),
		detail: {
			description: "Retrieve a paginated list of subtitles.",
		},
	})
	.post(
		"/upload",
		async ({ body, status }) =>
			status(
				201,
				await subtitlesService.upload(
					{
						mediaFileId: body.mediaFileId,
						language: body.language,
						...(body.label === undefined ? {} : { label: body.label }),
					},
					body.file,
				),
			),
		{
			adminOnly: true,
			rateLimit: routeLimit("subtitle-upload", 30),
			body: t.Object({
				mediaFileId: t.String({ minLength: 1 }),
				language: t.String({ minLength: 2, maxLength: 16 }),
				label: t.Optional(t.String({ maxLength: 100 })),
				file: t.File({ maxSize: SUBTITLE_UPLOAD_MAX_SIZE }),
			}),
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 201: "subtitle.schema" },
			detail: {
				description: "Store an SRT, WebVTT or ASS file (up to 1 MB) as an external subtitle track of a media file.",
			},
		},
	)
	.post("/", async ({ body }) => await subtitlesService.create(body), {
		adminOnly: true,
		body: "subtitle.create.body",
		response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 201: "subtitle.schema" },
		detail: {
			description: "Create a new subtitle record.",
		},
	})
	.get(
		"/:id/content",
		async ({ params, headers, request, user, profile }) => {
			// Subtitle content is stream-adjacent: it must honour the same plugin
			// access policies (e.g. parental control) as the media stream itself,
			// not just "is signed in".
			const subtitle = await subtitlesService.getById(params.id);
			await assertRouteMediaAccess({ user, profile }, subtitle.mediaFileId);
			const content = await subtitlesService.getContent(params.id, request.signal);

			return binaryFileResponse(content.file, content.contentType, SUBTITLE_CACHE_CONTROL, headers["if-none-match"]);
		},
		{
			profileRequired: true,
			// Each miss spawns an FFmpeg extraction; cap the request rate per profile.
			rateLimit: routeLimit("subtitle-content", 30),
			params: IdParams,
			...cached({ maxAge: 300, private: true }),
			response: { ...BinaryNotModifiedSchema, ...ROUTE_ERRORS.NOT_FOUND },
			detail: {
				description: "Read a downloaded subtitle without exposing its storage path.",
			},
		},
	)
	.get("/:id", async ({ params }) => await subtitlesService.getById(params.id), {
		params: IdParams,
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "subtitle.schema" },
		...cached({ maxAge: 60, private: true }),
		detail: {
			description: "Retrieve detailed information about a specific subtitle by its ID.",
		},
	})
	.patch("/:id", async ({ params, body }) => await subtitlesService.update(params.id, body), {
		adminOnly: true,
		params: IdParams,
		body: "subtitle.update.body",
		response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_NOT_FOUND, 200: "subtitle.schema" },
		detail: {
			description: "Modify an existing subtitle record.",
		},
	})
	.post("/bulk-delete", async ({ body }) => await subtitlesService.bulkDelete(body.ids), {
		adminOnly: true,
		rateLimit: routeLimit("subtitles-bulk-delete", 30),
		body: BulkSubtitleDeleteSchema,
		response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 200: BulkSubtitleDeleteResultSchema },
		detail: {
			description:
				"Permanently remove up to 200 subtitle records. Each id reports its own outcome, so one failure does not stop the others.",
		},
	})
	.delete("/:id", async ({ params }) => await subtitlesService.delete(params.id), {
		adminOnly: true,
		params: IdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "success.response" },
		detail: {
			description: "Permanently remove a subtitle record.",
		},
	});
