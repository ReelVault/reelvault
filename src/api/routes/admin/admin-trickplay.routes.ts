import { OperationQueuedResponseSchema, TrickplayDeleteResultSchema, TrickplayStatsSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { MediaFileIdParams } from "@/api/schemas/route-params";
import { recordAuditSafe } from "@/application/admin/admin-audit.service";
import { mediaArtifactsService } from "@/modules/artifacts/media-artifacts.service";
import { trickplayService } from "@/modules/trickplay/trickplay.service";
import { MINUTE } from "@/server.constants";
import { createLogger } from "@/utils/logger";
import { enqueueTrickplayGeneration, enqueueTrickplayGenerationMany } from "@/workers/definitions/media/trickplay-generate.worker";
import { adminShell } from "./admin-shell";

const trickplayAuditLogger = createLogger("AdminTrickplayRoutes");

export const adminTrickplayRoutes = adminShell({ prefix: "/trickplay", tags: ["Admin"] })
	.get("/stats", async () => await trickplayService.stats(), {
		response: { ...ROUTE_ERRORS.ADMIN, 200: TrickplayStatsSchema },
		detail: { description: "Counts of media files with and without built-in trickplay previews, plus core artifact storage usage." },
	})
	.get("/artifacts/stats", async () => ({ artifacts: await mediaArtifactsService.countByOwnerAndKind() }), {
		response: {
			...ROUTE_ERRORS.ADMIN,
			200: t.Object({
				artifacts: t.Array(t.Object({ pluginId: t.String(), kind: t.String(), count: t.Integer({ minimum: 0 }) })),
			}),
		},
		detail: { description: "Artifact rows per owner (core or plugin) and kind, for the storage overview." },
	})
	.delete(
		"/media/:mediaFileId",
		async ({ params, user, request }) => {
			const result = await trickplayService.deletePreviews([params.mediaFileId]);
			recordAuditSafe(
				{
					action: "delete",
					resourceType: "trickplay",
					resourceId: params.mediaFileId,
					summary: `${result.artifacts} trickplay artifact(s) removed`,
					context: { actorUserId: user?.id, headers: request.headers },
				},
				trickplayAuditLogger,
			);

			return result;
		},
		{
			params: MediaFileIdParams,
			response: { ...ROUTE_ERRORS.ADMIN, 200: TrickplayDeleteResultSchema },
			detail: { description: "Remove the core trickplay previews of one media file. Files without previews are left alone." },
		},
	)
	.post(
		"/media/delete",
		async ({ body, user, request }) => {
			const result = await trickplayService.deletePreviews(body.mediaFileIds);
			recordAuditSafe(
				{
					action: "delete",
					resourceType: "trickplay",
					summary: `${result.artifacts} trickplay artifact(s) removed from ${result.mediaFiles} media file(s)`,
					after: { mediaFileIds: body.mediaFileIds },
					context: { actorUserId: user?.id, headers: request.headers },
				},
				trickplayAuditLogger,
			);

			return result;
		},
		{
			rateLimit: { name: "admin-trickplay-delete-bulk", max: 10, windowMs: MINUTE },
			body: t.Object({ mediaFileIds: t.Array(t.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 500 }) }),
			response: { ...ROUTE_ERRORS.ADMIN, 200: TrickplayDeleteResultSchema },
			detail: { description: "Remove the core trickplay previews of up to 500 media files at once." },
		},
	)
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
