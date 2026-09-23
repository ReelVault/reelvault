import { OperationQueuedResponseSchema } from "@sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { MediaFileIdParams } from "@/api/schemas/route-params";
import { authMiddleware } from "@/middleware/auth.middleware";
import { trickplayService } from "@/modules/trickplay/trickplay.service";
import { enqueueTrickplayGeneration } from "@/workers/definitions/media/trickplay-generate.worker";

export const adminTrickplayRoutes = new Elysia({ prefix: "/trickplay", tags: ["Admin"] })
	.use(commonModel)
	.use(authMiddleware)
	.guard({ adminOnly: true })
	.get("/stats", async () => await trickplayService.stats(), {
		detail: { description: "Counts of media files with and without built-in trickplay previews." },
	})
	.post(
		"/generate/:mediaFileId",
		async ({ params, status }) => {
			const task = await enqueueTrickplayGeneration(params.mediaFileId);

			return status(202, { success: true, operationId: task.operationId ?? task.id, status: "pending" as const });
		},
		{
			params: MediaFileIdParams,
			response: {
				...ROUTE_ERRORS.ADMIN,
				202: OperationQueuedResponseSchema,
			},
			detail: { description: "Enqueue trickplay generation for a single media file." },
		},
	)
	.post(
		"/generate-all",
		async ({ status }) => {
			const mediaFileIds = await trickplayService.findMediaFileIdsMissingTrickplay();
			for (const mediaFileId of mediaFileIds) {
				await enqueueTrickplayGeneration(mediaFileId);
			}

			return status(202, { enqueued: mediaFileIds.length });
		},
		{
			rateLimit: { name: "admin-trickplay-generate-all", max: 5, windowMs: 60_000 },
			response: {
				...ROUTE_ERRORS.ADMIN,
				202: t.Object({ enqueued: t.Number() }),
			},
			detail: { description: "Enqueue trickplay generation for every media file that is missing it." },
		},
	);
