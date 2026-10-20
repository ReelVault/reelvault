import {
	AdminEndedLiveSessionsResponseSchema,
	AdminLiveActivityResponseSchema,
	BulkTerminateSessionsResultSchema,
	BulkTerminateSessionsSchema,
} from "@reelvault/sdk/common";
import { t } from "elysia";
import { adminLiveSessionsService } from "@/app/admin/admin-live-sessions.service";
import { ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { SessionIdParams } from "@/app/http/schemas/route-params.schema";
import { actorContext } from "@/app/http/utils/audit-context.utils";
import { attachmentResponse } from "@/app/http/utils/binary-response.utils";
import { MINUTE } from "@/config/server/server.constants";
import { ENDED_SESSION_HISTORY_LIMIT } from "@/modules/streaming/runtime/ended-session.history";
import { adminShell } from "./admin-shell.routes";

/** How many ended sessions the history returns when the request does not ask for a count. */
const ENDED_SESSIONS_PAGE = 50;

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
	.get("/history", async ({ query }) => await adminLiveSessionsService.getEndedSessions(query.limit ?? ENDED_SESSIONS_PAGE), {
		rateLimit: { name: "admin-live-activity-history", max: 120, windowMs: MINUTE },
		query: t.Optional(t.Object({ limit: t.Optional(t.Integer({ minimum: 1, maximum: ENDED_SESSION_HISTORY_LIMIT })) })),
		response: { ...ROUTE_ERRORS.ADMIN, 200: AdminEndedLiveSessionsResponseSchema },
		detail: {
			description: "List the most recently ended live playback sessions, newest first, with their reason and duration.",
		},
	})
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
	.get(
		"/:sessionId/log",
		async ({ params }) => {
			const archive = await adminLiveSessionsService.getSessionLog(params.sessionId);

			return attachmentResponse(archive.data, { filename: archive.filename, contentType: "application/zip" });
		},
		{
			rateLimit: { name: "admin-live-session-log", max: 10, windowMs: MINUTE },
			params: SessionIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: t.Any() },
			detail: {
				description:
					"Download the FFmpeg logs of a live or recently ended playback session as a zip: every operation log the session wrote, plus a timeline.json of its runs (start, end, exit code and error).",
			},
		},
	)
	.post(
		"/terminate",
		async ({ body, user, request }) => await adminLiveSessionsService.terminateSessions(body, actorContext({ user, request })),
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
