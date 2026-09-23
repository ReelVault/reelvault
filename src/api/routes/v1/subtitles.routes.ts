import {
	CreateSubtitleRequestSchema,
	SubtitleFiltersSchema,
	SubtitleProviderDownloadRequestSchema,
	SubtitleProviderSearchRequestSchema,
	SubtitleProviderSearchResponseSchema,
	SubtitleProviderStatusSchema,
	SubtitleSchema,
	SubtitleSortingSchema,
	UpdateSubtitleRequestSchema,
} from "@sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, PaginatedResponseSchema, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { IdParams } from "@/api/schemas/route-params";
import { binaryFileResponse } from "@/api/utils/binary-response.utils";
import { authMiddleware } from "@/middleware/auth.middleware";
import { assertActiveStreamAccess } from "@/modules/streaming/sessions/stream-access";
import { subtitlesService } from "@/modules/subtitles/subtitles.service";
import { MINUTE } from "@/server.constants";

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
		response: { ...ROUTE_ERRORS.AUTH, 200: t.Array(SubtitleProviderStatusSchema) },
		cache: { maxAge: 300, private: true },
		deduplicate: {},
		detail: {
			description: "List installed subtitle providers.",
		},
	})
	.post("/search", async ({ body }) => await subtitlesService.searchProviders(body), {
		rateLimit: {
			name: "subtitle-search",
			max: 30,
			windowMs: MINUTE,
		},
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
			params: t.Object({ providerId: t.String() }),
			body: SubtitleProviderDownloadRequestSchema,
			response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: "subtitle.schema" },
			detail: {
				description: "Download a subtitle through an installed provider into core-managed storage.",
			},
		},
	)
	.get("/", async ({ query }) => await subtitlesService.getAll(query), {
		query: t.Composite([PaginationSchema, SubtitleFiltersSchema, SubtitleSortingSchema]),
		response: { ...ROUTE_ERRORS.AUTH, 200: "subtitles.paginated.schema" },
		cache: { maxAge: 60, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve a paginated list of subtitles.",
		},
	})
	.post("/", async ({ body }) => await subtitlesService.create(body), {
		adminOnly: true,
		body: "subtitle.create.body",
		response: { ...ROUTE_ERRORS.VALIDATED, 201: "subtitle.schema" },
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
			await assertActiveStreamAccess({ userId: user?.id, profileId: profile?.id, mediaFileId: subtitle.mediaFileId });
			const content = await subtitlesService.getContent(params.id, request.signal);

			return binaryFileResponse(content.file, content.contentType, SUBTITLE_CACHE_CONTROL, headers["if-none-match"]);
		},
		{
			profileRequired: true,
			// Each miss spawns an FFmpeg extraction; cap the request rate per profile.
			rateLimit: { name: "subtitle-content", max: 30, windowMs: MINUTE },
			params: IdParams,
			cache: { maxAge: 300, private: true },
			deduplicate: {},
			response: {
				// Binary subtitle body (or 304) — handler returns a Response, not JSON.
				200: t.Any(),
				...ROUTE_ERRORS.NOT_FOUND,
				304: t.Any(),
			},
			detail: {
				description: "Read a downloaded subtitle without exposing its storage path.",
			},
		},
	)
	.get("/:id", async ({ params }) => await subtitlesService.getById(params.id), {
		params: t.Object({
			id: t.String(),
		}),
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "subtitle.schema" },
		cache: { maxAge: 60, private: true },
		deduplicate: {},
		detail: {
			description: "Retrieve detailed information about a specific subtitle by its ID.",
		},
	})
	.patch("/:id", async ({ params, body }) => await subtitlesService.update(params.id, body), {
		adminOnly: true,
		params: t.Object({
			id: t.String(),
		}),
		body: "subtitle.update.body",
		response: { ...ROUTE_ERRORS.VALIDATED_NOT_FOUND, 200: "subtitle.schema" },
		detail: {
			description: "Modify an existing subtitle record.",
		},
	})
	.delete("/:id", async ({ params }) => await subtitlesService.delete(params.id), {
		adminOnly: true,
		params: t.Object({
			id: t.String(),
		}),
		response: { ...ROUTE_ERRORS.NOT_FOUND, 200: "success.response" },
		detail: {
			description: "Permanently remove a subtitle record.",
		},
	});
