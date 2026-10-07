import { PlaybackCommandResponseSchema, PlaybackCommandSchema } from "@reelvault/sdk/common";
import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { SessionIdParams } from "@/api/schemas/route-params";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { wsProtocol } from "@/modules/realtime/ws-protocol.service";
import { assertSessionAccess } from "@/modules/streaming/sessions/session-access.guard";
import { MINUTE } from "@/server.constants";
import { UnauthorizedError } from "@/utils/errors";

export const eventsRoutes = new Elysia({ prefix: "/events" })
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.post(
		"/playback-sessions/:sessionId/command",
		async ({ params, body, user, profile }) => {
			await assertSessionAccess(params.sessionId, user?.id, profile?.id);
			const delivered = realtimeService.sendPlaybackCommand(params.sessionId, body, profile?.id);

			return {
				delivered,
				command: body.type,
				...(body.position != null ? { position: body.position } : {}),
				...(body.relative != null ? { relative: body.relative } : {}),
				...(body.volume != null ? { volume: body.volume } : {}),
			};
		},
		{
			rateLimit: { name: "playback-command", max: 240, windowMs: MINUTE },
			params: SessionIdParams,
			body: PlaybackCommandSchema,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: PlaybackCommandResponseSchema },
			detail: { description: "Send a remote playback command (play, pause, seek, stop, setVolume) to an active session." },
		},
	)
	.ws("/ws", {
		query: t.Object({
			profileId: t.Optional(t.String()),
		}),
		async beforeHandle({ query, profile, user, cookie }) {
			if (!user) throw new UnauthorizedError("Authentication required to connect to websocket");
			if (profile || !query.profileId) return;

			const unlockToken = typeof cookie.profile_unlock?.value === "string" ? cookie.profile_unlock.value : undefined;
			await wsProtocol.assertHandshakeProfile(user.id, query.profileId, unlockToken);
		},
		open(ws) {
			const { user, profile, session, query } = ws.data;
			if (!user) {
				ws.close(4001, "Unauthorized");

				return;
			}

			wsProtocol.onOpen(ws, {
				userId: user.id,
				profileId: profile?.id ?? query.profileId ?? null,
				sessionId: session?.id ?? null,
				isAdmin: user.role === "admin",
			});
		},
		async message(ws, message) {
			await wsProtocol.onMessage(ws, message, ws.data.user?.id);
		},
		close(ws) {
			wsProtocol.onClose(ws);
		},
	});
