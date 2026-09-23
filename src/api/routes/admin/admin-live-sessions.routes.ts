import { AdminLiveActivityResponseSchema } from "@sdk/common";
import Elysia, { t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { SessionIdParams } from "@/api/schemas/route-params";
import { adminLiveSessionsService } from "@/application/admin/admin-live-sessions.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";

export const adminLiveSessionsRoutes = new Elysia({ prefix: "/live-activity", tags: ["Admin"] })
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.guard({ adminOnly: true })
	.get(
		"",
		async () => {
			return await adminLiveSessionsService.getLiveActivity();
		},
		{
			rateLimit: { name: "admin-live-activity", max: 120, windowMs: 60_000 },
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
			rateLimit: { name: "admin-live-session-terminate", max: 30, windowMs: 60_000 },
			params: SessionIdParams,
			query: t.Optional(t.Object({ reason: t.Optional(t.String()) })),
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "success.response" },
			detail: {
				description: "Terminate/kill an active video playback stream on the server.",
			},
		},
	);
