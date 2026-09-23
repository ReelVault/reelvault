import { DownloadJobSchema, MyDownloadsResponseSchema, PrepareDownloadSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { JobIdParams } from "@/api/schemas/route-params";
import { authMiddleware } from "@/middleware/auth.middleware";
import { downloadsService } from "@/modules/downloads/downloads.service";
import { assertActiveStreamAccess } from "@/modules/streaming/sessions/stream-access";

export const downloadsRoutes = new Elysia({ prefix: "/downloads", tags: ["Downloads"] })
	.use(commonModel)
	.use(authMiddleware)
	.guard({ auth: true, profileRequired: true })
	.get("/", async ({ profile }) => await downloadsService.list(profile?.id ?? ""), {
		response: { ...ROUTE_ERRORS.AUTH, 200: MyDownloadsResponseSchema },
		detail: { description: "List the calling profile's offline downloads." },
	})
	.post(
		"/prepare",
		async ({ body, user, profile }) => {
			await assertActiveStreamAccess({ userId: user?.id, profileId: profile?.id, mediaFileId: body.mediaFileId });

			return await downloadsService.prepare(profile?.id ?? "", body.mediaFileId, body.quality);
		},
		{
			rateLimit: { name: "downloads-prepare", max: 10, windowMs: 60_000 },
			body: PrepareDownloadSchema,
			response: { ...ROUTE_ERRORS.VALIDATED_ADMIN_RATE_LIMITED, 200: DownloadJobSchema },
			detail: { description: "Prepare an offline (MP4) download of a media file." },
		},
	)
	.get("/:jobId/status", async ({ params, profile }) => await downloadsService.getJobViewForProfile(params.jobId, profile?.id ?? ""), {
		params: JobIdParams,
		response: { 200: t.Nullable(DownloadJobSchema), 404: "error.response" },
		detail: { description: "Status of a single download job owned by the calling profile." },
	})
	.get(
		"/:jobId/file",
		async ({ params, profile }) => {
			const result = await downloadsService.resolveFileForProfile(params.jobId, profile?.id ?? "");
			if (!result) return new Response("Not found", { status: 404 });

			return new Response(result.blob, {
				headers: {
					"Content-Type": "video/mp4",
					"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
					"Cache-Control": "no-store",
				},
			});
		},
		{
			params: JobIdParams,
			detail: { description: "Download the finished MP4 file (completed jobs only)." },
		},
	)
	.delete("/:jobId", async ({ params, profile }) => await downloadsService.deleteForProfile(params.jobId, profile?.id ?? ""), {
		params: JobIdParams,
		response: { 200: t.Object({ success: t.Boolean() }), 404: "error.response" },
		detail: { description: "Delete a download (and its file) owned by the calling profile." },
	});
