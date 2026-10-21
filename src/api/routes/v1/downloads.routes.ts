import {
	DownloadJobSchema,
	DownloadSeasonQueueResultSchema,
	MyDownloadsResponseSchema,
	PrepareDownloadSchema,
	QueueSeasonDownloadSchema,
	SuccessResponseSchema,
} from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { authMiddleware } from "@/api/middleware/auth.middleware";
import { routeLimit } from "@/api/middleware/rate-limit.middleware";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schema";
import { JobIdParams } from "@/api/schemas/route-params.schema";
import { assertRouteMediaAccess, requireProfileId } from "@/api/utils/access-context.utils";
import { attachmentResponse } from "@/api/utils/binary-response.utils";
import { downloadsService } from "@/modules/downloads/downloads.service";

export const downloadsRoutes = new Elysia({ prefix: "/downloads", tags: ["Downloads"] })
	.use(commonModel)
	.use(authMiddleware)
	.guard({ auth: true, profileRequired: true })
	.get("/", async ({ profile }) => await downloadsService.list(requireProfileId(profile)), {
		response: { ...ROUTE_ERRORS.AUTH, 200: MyDownloadsResponseSchema },
		detail: { description: "List the calling profile's offline downloads." },
	})
	.post(
		"/prepare",
		async ({ body, user, profile }) => {
			await assertRouteMediaAccess({ user, profile }, body.mediaFileId);

			return await downloadsService.prepare(requireProfileId(profile), body.mediaFileId, body.quality);
		},
		{
			rateLimit: routeLimit("downloads-prepare", 10),
			body: PrepareDownloadSchema,
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 429: "error.response", 200: DownloadJobSchema },
			detail: { description: "Prepare an offline (MP4) download of a media file." },
		},
	)
	.post(
		"/seasons",
		async ({ body, user, profile }) =>
			await downloadsService.queueSeason(profile?.id, body, (mediaFileId) => assertRouteMediaAccess({ user, profile }, mediaFileId)),
		{
			rateLimit: routeLimit("downloads-queue-season", 10),
			body: QueueSeasonDownloadSchema,
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN, 429: "error.response", 200: DownloadSeasonQueueResultSchema },
			detail: {
				description:
					"Queue every episode of a season for offline download. Each episode reports its own outcome. A season larger than the free storage is refused unless `force` is set.",
			},
		},
	)
	.get(
		"/:jobId/status",
		async ({ params, profile }) => await downloadsService.getJobViewForProfile(params.jobId, requireProfileId(profile)),
		{
			params: JobIdParams,
			response: { 200: t.Nullable(DownloadJobSchema), 404: "error.response" },
			detail: { description: "Status of a single download job owned by the calling profile." },
		},
	)
	.get(
		"/:jobId/file",
		async ({ params, profile }) => {
			const result = await downloadsService.resolveFileForProfile(params.jobId, requireProfileId(profile));
			if (!result) return new Response("Not found", { status: 404 });

			return attachmentResponse(result.blob, {
				filename: result.fileName,
				contentType: "video/mp4",
				rfc5987: true,
				headers: { "Cache-Control": "no-store" },
			});
		},
		{
			params: JobIdParams,
			detail: { description: "Download the finished MP4 file (completed jobs only)." },
		},
	)
	.post("/:jobId/cancel", async ({ params, profile }) => await downloadsService.cancelForProfile(params.jobId, requireProfileId(profile)), {
		params: JobIdParams,
		response: { 200: SuccessResponseSchema, 404: "error.response", 409: "error.response" },
		detail: { description: "Cancel a pending or running download; its partial file is removed." },
	})
	.post(
		"/:jobId/retry",
		async ({ params, user, profile }) => {
			const mediaFileId = await downloadsService.mediaFileIdForProfile(params.jobId, requireProfileId(profile));
			await assertRouteMediaAccess({ user, profile }, mediaFileId);

			return await downloadsService.retryForProfile(params.jobId, requireProfileId(profile));
		},
		{
			rateLimit: routeLimit("downloads-retry", 10),
			params: JobIdParams,
			response: { 200: DownloadJobSchema, 404: "error.response", 409: "error.response" },
			detail: { description: "Queue a new download of the same file and quality after a failed or cancelled one." },
		},
	)
	.delete("/:jobId", async ({ params, profile }) => await downloadsService.deleteForProfile(params.jobId, requireProfileId(profile)), {
		params: JobIdParams,
		response: { 200: SuccessResponseSchema, 404: "error.response" },
		detail: { description: "Delete a download (and its file) owned by the calling profile." },
	});
