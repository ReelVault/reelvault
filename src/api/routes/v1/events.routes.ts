import { PlaybackCommandResponseSchema, PlaybackCommandSchema } from "@reelvault/sdk/common";
import { Value } from "@sinclair/typebox/value";
import { Elysia, t } from "elysia";
import { commonModel, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { SessionIdParams } from "@/api/schemas/route-params";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { env } from "@/env";
import { authMiddleware } from "@/middleware/auth.middleware";
import { InMemoryRateLimiter, rateLimitMiddleware } from "@/middleware/rate-limit.middleware";
import { realtimeService } from "@/modules/realtime";
import { streamingService } from "@/modules/streaming/runtime/streaming.manager";
import { assertSessionAccess } from "@/modules/streaming/sessions/session-access.guard";
import { assertActiveStreamAccess } from "@/modules/streaming/sessions/stream-access";
import { MINUTE } from "@/server.constants";
import { ForbiddenError, UnauthorizedError } from "@/utils/errors";
import { safeParseJson } from "@/utils/file.utils";
import { isProfileUnlocked } from "@/utils/profile-unlock.utils";
import { isRecord } from "@/utils/type.utils";

async function checkPlaybackSessionOwnership(
	sessionId: string,
	connectedProfileId: string | null | undefined,
	userId?: string,
): Promise<{ allowed: boolean; access?: NonNullable<ReturnType<typeof streamingService.getSessionAccess>> }> {
	const access = streamingService.getSessionAccess(sessionId);
	if (!access) return { allowed: false };

	if (typeof connectedProfileId === "string" && access.profileId === connectedProfileId) {
		return { allowed: true, access };
	}

	if (userId) {
		const sessionProfile = await profilesRepository.findByPrimaryIdCached(access.profileId);
		if (sessionProfile?.userId === userId) {
			// Account ownership is not enough for a PIN-protected profile: only a
			// connection already unlocked for that exact profile may control it.
			if (sessionProfile.pin) return { allowed: false, access };

			return { allowed: true, access };
		}
	}

	return { allowed: false, access };
}

interface WebSocketClientState {
	connectionId: string;
	profileId: string | null;
}

const clientStates = new WeakMap<object, WebSocketClientState>();

/** Inbound frames are tiny control messages (ping/subscribe/command); anything
 * bigger is hostile or broken — drop before parsing. */
const WS_MAX_INBOUND_CHARS = 16_384;
/** Inbound frames per connection per window; playback commands also go through
 * the HTTP limiter, this only stops a runaway socket from burning the loop. */
const WS_MESSAGE_LIMIT = 240;
const WS_MESSAGE_WINDOW_MS = 10_000;
const wsMessageLimiter = new InMemoryRateLimiter();

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
		// Browsers cannot set headers on a WebSocket upgrade, so the profile may
		// arrive as a query param instead of the cookie/header authMiddleware
		// verifies — it gets the same ownership check here, otherwise any signed-in
		// client could receive another user's profile-scoped events.
		async beforeHandle({ query, profile, user, cookie }) {
			if (!user) throw new UnauthorizedError("Authentication required to connect to websocket");

			if (profile || !query.profileId) return;

			const requested = await profilesRepository.findByPrimaryIdCached(query.profileId);
			if (!requested || requested.userId !== user.id) {
				throw new ForbiddenError("Profile does not belong to the current user");
			}

			// A PIN-protected profile must not be reachable by passing profileId as a
			// query param: the signed unlock cookie proves the PIN was entered, exactly
			// like authMiddleware for HTTP requests.
			if (requested.pin) {
				const unlockToken = typeof cookie.profile_unlock?.value === "string" ? cookie.profile_unlock.value : undefined;
				if (!isProfileUnlocked(requested, unlockToken, env.BETTER_AUTH_SECRET)) {
					throw new ForbiddenError("Profile is locked", { code: "auth.profile_locked" });
				}
			}
		},
		open(ws) {
			const { user, profile, session } = ws.data;
			if (!user) {
				ws.close(4001, "Unauthorized");

				return;
			}

			const connectionId = crypto.randomUUID();
			const effectiveProfileId = profile?.id ?? ws.data.query.profileId ?? null;

			clientStates.set(ws, { connectionId, profileId: effectiveProfileId });

			realtimeService.register({
				connectionId,
				userId: user.id,
				profileId: effectiveProfileId,
				// The auth session ID is stored here for reference but playback commands
				// are delivered via the HLS session ID registered through subscribe_session.
				sessionId: session?.id ?? null,
				socket: ws,
				connectedAt: new Date(),
			});
		},
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: single WS dispatcher for ping/subscribe/unsubscribe/command
		async message(ws, message) {
			const wsState = clientStates.get(ws);
			// Any inbound frame proves the peer is alive. Refresh liveness before
			// handling so idle-but-healthy sockets are not reaped as stale.
			if (wsState) realtimeService.touch(wsState.connectionId);

			if (message === "ping") {
				ws.send(JSON.stringify({ type: "pong", occurredAt: new Date().toISOString() }));

				return;
			}

			if (typeof message === "string" && message.length > WS_MAX_INBOUND_CHARS) return;

			let msg: Record<string, unknown> | null;
			if (typeof message === "string") {
				const parsed = safeParseJson(message);
				msg = isRecord(parsed) ? parsed : null;
			} else if (isRecord(message)) msg = message;
			else msg = null;

			if (!msg || typeof msg.type !== "string") return;

			if (msg.type === "ping") {
				ws.send(JSON.stringify({ type: "pong", occurredAt: new Date().toISOString() }));

				return;
			}

			if (!wsState) return;

			const connectionId = wsState.connectionId;
			if (!wsMessageLimiter.consume(connectionId, WS_MESSAGE_LIMIT, WS_MESSAGE_WINDOW_MS).allowed) {
				ws.close(1008, "Message rate limit exceeded");

				return;
			}

			if (msg.type === "subscribe_session" && typeof msg.sessionId === "string") {
				const { allowed, access } = await checkPlaybackSessionOwnership(msg.sessionId, wsState.profileId, ws.data.user?.id);
				if (!(allowed && access)) {
					ws.send(JSON.stringify({ type: "session:subscribe:denied", sessionId: msg.sessionId }));

					return;
				}

				// Keep the connection's registered profile immutable — the registry
				// indexes connections by it, so mutating wsState only made
				// `sendToProfile` miss this connection. Cross-profile ownership is
				// already granted through the userId branch above.
				const subscribed = realtimeService.subscribeToPlaybackSession(connectionId, msg.sessionId);
				if (!subscribed) {
					ws.send(JSON.stringify({ type: "session:subscribe:denied", sessionId: msg.sessionId, reason: "limit_reached" }));

					return;
				}

				ws.send(JSON.stringify({ type: "session:subscribe:confirmed", sessionId: msg.sessionId }));

				return;
			}

			if (msg.type === "unsubscribe_session" && typeof msg.sessionId === "string") {
				realtimeService.unsubscribeFromPlaybackSession(connectionId, msg.sessionId);

				return;
			}

			if (msg.type === "playback_command" && typeof msg.sessionId === "string" && Value.Check(PlaybackCommandSchema, msg.command)) {
				const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
				const { allowed, access } = await checkPlaybackSessionOwnership(msg.sessionId, wsState.profileId, ws.data.user?.id);
				if (!(allowed && access)) {
					const error = access ? "forbidden" : "not_found";
					ws.send(JSON.stringify({ type: "playback_command_error", sessionId: msg.sessionId, error, ...(requestId ? { requestId } : {}) }));

					return;
				}

				// Plugin access policies (e.g. parental control) gate the HTTP command
				// route — the WS channel must not be a bypass (audit 2026-09-15).
				try {
					await assertActiveStreamAccess({ userId: ws.data.user?.id, profileId: access.profileId, mediaFileId: access.mediaFileId });
				} catch {
					ws.send(
						JSON.stringify({
							type: "playback_command_error",
							sessionId: msg.sessionId,
							error: "forbidden",
							...(requestId ? { requestId } : {}),
						}),
					);

					return;
				}

				const command = msg.command;
				const delivered = realtimeService.sendPlaybackCommand(msg.sessionId, command, wsState.profileId ?? access.profileId);
				ws.send(
					JSON.stringify({
						type: "playback_command_ack",
						sessionId: msg.sessionId,
						command: command.type,
						delivered,
						...(requestId ? { requestId } : {}),
					}),
				);

				return;
			}
		},
		close(ws) {
			const wsState = clientStates.get(ws);
			if (wsState) {
				realtimeService.unregister(wsState.connectionId);
				clientStates.delete(ws);
			}
		},
	});
