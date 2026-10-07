import { OperationQueuedResponseSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { MediaFileIdParams } from "@/api/schemas/route-params";
import { trickplayService } from "@/modules/trickplay/trickplay.service";
import { MINUTE } from "@/server.constants";
import { enqueueTrickplayGeneration, enqueueTrickplayGenerationMany } from "@/workers/definitions/media/trickplay-generate.worker";
import { adminShell } from "./admin-shell";

export const adminTrickplayRoutes = adminShell({ prefix: "/trickplay", tags: ["Admin"] })
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
			// One batched enqueue (shared operation, chunked inserts) instead of a
			// per-file operation/transaction — thousands of files land in one pass.
			const { operationId, items } = await enqueueTrickplayGenerationMany(mediaFileIds);

			return status(202, { enqueued: items.length, ...(operationId ? { operationId } : {}) });
		},
		{
			rateLimit: { name: "admin-trickplay-generate-all", max: 5, windowMs: MINUTE },
			response: {
				...ROUTE_ERRORS.ADMIN,
				202: t.Object({ enqueued: t.Number(), operationId: t.Optional(t.String()) }),
			},
			detail: { description: "Enqueue trickplay generation for every media file that is missing it." },
		},
	);
