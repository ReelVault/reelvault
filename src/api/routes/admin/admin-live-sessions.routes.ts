import { AdminLiveActivityResponseSchema, BulkTerminateSessionsResultSchema, BulkTerminateSessionsSchema } from "@reelvault/sdk/common";
import { t } from "elysia";
import { ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { SessionIdParams } from "@/api/schemas/route-params";
import { adminLiveSessionsService } from "@/application/admin/admin-live-sessions.service";
import { MINUTE } from "@/server.constants";
import { adminShell } from "./admin-shell";

export const adminLiveSessionsRoutes = adminShell({ prefix: "/live-activity", tags: ["Admin"] })
	.get(
		"",
		async () => {
			return await adminLiveSessionsService.getLiveActivity();
		},
		{
			rateLimit: { name: "admin-live-activity", max: 120, windowMs: MINUTE },
			response: { ...ROUTE_ERRORS.ADMIN, 200: AdminLiveActivityResponseSchema },
			detail: {
				description: "Get real-time live streaming sessions and active connected devices.",
			},
		},
	)
	.delete(
		"/:sessionId",
		async ({ params, query }) => {
			return await adminLiveSessionsService.terminateSession(params.sessionId, query.reason);
		},
		{
			rateLimit: { name: "admin-live-session-terminate", max: 30, windowMs: MINUTE },
			params: SessionIdParams,
			query: t.Optional(t.Object({ reason: t.Optional(t.String({ maxLength: 200 })) })),
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "success.response" },
			detail: {
				description: "Terminate/kill an active video playback stream on the server.",
			},
		},
	)
	.post(
		"/terminate",
		async ({ body, user, request }) =>
			await adminLiveSessionsService.terminateSessions(body, {
				actorUserId: user?.id,
				headers: request.headers,
			}),
		{
			rateLimit: { name: "admin-live-session-bulk-terminate", max: 10, windowMs: MINUTE },
			body: BulkTerminateSessionsSchema,
			response: { ...ROUTE_ERRORS.ADMIN, 200: BulkTerminateSessionsResultSchema },
			detail: {
				description:
					"Terminate several playback streams at once. Each one is attempted on its own and reported, and the outcome is audited.",
			},
		},
	);
