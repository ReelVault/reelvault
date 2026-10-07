import type { PlaybackCommand } from "@reelvault/sdk/common";
import { PlaybackCommandSchema } from "@reelvault/sdk/common";
import { Value } from "@sinclair/typebox/value";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { env } from "@/env";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { assertActiveStreamAccess } from "@/modules/streaming/sessions/stream-access";
import { ForbiddenError } from "@/utils/errors";
import { safeParseJson } from "@/utils/file.utils";
import { InMemoryRateLimiter } from "@/utils/in-memory-rate-limiter";
import { isProfileUnlocked } from "@/utils/profile-unlock.utils";
import { isRecord } from "@/utils/type.utils";
import { realtimeService } from "./realtime.service";
import type { RealtimeSocket } from "./realtime.types";

/** Minimal socket surface the protocol needs — satisfied by Elysia's WS wrapper. */
export interface ProtocolSocket {
	readonly raw: RealtimeSocket;
	send(data: string): unknown;
	close(code: number, reason: string): void;
}

interface WebSocketClientState {
	connectionId: string;
	profileId: string | null;
}

/**
 * Elysia constructs a fresh `ElysiaWS` wrapper for every event (`open`,
 * `message`, `close`), so the wrapper is useless as a per-connection key.
 * `ws.raw` is the stable Bun socket — keying by anything else silently breaks
 * `touch()` (the stale sweep then reaps live connections) and command dispatch.
 */
const clientStates = new WeakMap<object, WebSocketClientState>();

/** Inbound frames are tiny control messages (ping/subscribe/command); anything
 * bigger is hostile or broken — drop before parsing. */
const WS_MAX_INBOUND_CHARS = 16_384;
/** Inbound frames per connection per window; playback commands also go through
 * the HTTP limiter, this only stops a runaway socket from burning the loop. */
const WS_MESSAGE_LIMIT = 240;
const WS_MESSAGE_WINDOW_MS = 10_000;
const wsMessageLimiter = new InMemoryRateLimiter();

type SessionAccess = NonNullable<ReturnType<typeof streamingManager.getSessionAccess>>;

async function checkPlaybackSessionOwnership(
	sessionId: string,
	connectedProfileId: string | null | undefined,
	userId?: string,
): Promise<{ allowed: boolean; access?: SessionAccess }> {
	const access = streamingManager.getSessionAccess(sessionId);
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

/**
 * WebSocket wire protocol for realtime events: inbound frame parsing, liveness
 * tracking, per-connection rate limiting, playback-session authorization and
 * response framing. Routes only bind this to Elysia's socket events.
 */
export const wsProtocol = {
	/**
	 * Validates a profile requested via the WS upgrade query string. Browsers
	 * cannot set headers on a WebSocket upgrade, so the profile may arrive as a
	 * query param instead of the cookie/header authMiddleware verifies — it gets
	 * the same ownership check here, otherwise any signed-in client could receive
	 * another user's profile-scoped events.
	 */
	async assertHandshakeProfile(userId: string, queryProfileId: string, unlockToken: string | undefined): Promise<void> {
		const requested = await profilesRepository.findByPrimaryIdCached(queryProfileId);
		if (!requested || requested.userId !== userId) {
			throw new ForbiddenError("Profile does not belong to the current user");
		}

		// A PIN-protected profile must not be reachable by passing profileId as a
		// query param: the signed unlock cookie proves the PIN was entered, exactly
		// like authMiddleware for HTTP requests.
		if (requested.pin && !isProfileUnlocked(requested, unlockToken, env.BETTER_AUTH_SECRET)) {
			throw new ForbiddenError("Profile is locked", { code: "auth.profile_locked" });
		}
	},

	onOpen(
		ws: ProtocolSocket,
		input: { userId: string; profileId: string | null; sessionId: string | null; isAdmin?: boolean | undefined },
	): void {
		const connectionId = crypto.randomUUID();

		clientStates.set(ws.raw, { connectionId, profileId: input.profileId });

		realtimeService.register({
			connectionId,
			userId: input.userId,
			profileId: input.profileId,
			// The auth session ID is stored here for reference but playback commands
			// are delivered via the HLS session ID registered through subscribe_session.
			sessionId: input.sessionId,
			isAdmin: input.isAdmin,
			socket: ws.raw,
		});
	},

	async onMessage(ws: ProtocolSocket, message: unknown, userId: string | undefined): Promise<void> {
		const wsState = clientStates.get(ws.raw);
		// Any inbound frame proves the peer is alive. Refresh liveness before
		// handling so idle-but-healthy sockets are not reaped as stale.
		if (wsState) realtimeService.touch(wsState.connectionId);

		if (message === "ping") {
			sendPong(ws);

			return;
		}

		if (typeof message === "string" && message.length > WS_MAX_INBOUND_CHARS) return;

		const msg = parseFrame(message);
		if (!msg || typeof msg.type !== "string") return;

		if (msg.type === "ping") {
			sendPong(ws);

			return;
		}

		if (!wsState) return;

		const connectionId = wsState.connectionId;
		if (!wsMessageLimiter.consume(connectionId, WS_MESSAGE_LIMIT, WS_MESSAGE_WINDOW_MS).allowed) {
			ws.close(1008, "Message rate limit exceeded");

			return;
		}

		if (msg.type === "subscribe_session" && typeof msg.sessionId === "string") {
			await handleSubscribe(ws, connectionId, msg.sessionId, wsState.profileId, userId);

			return;
		}

		if (msg.type === "unsubscribe_session" && typeof msg.sessionId === "string") {
			realtimeService.unsubscribeFromPlaybackSession(connectionId, msg.sessionId);

			return;
		}

		if (msg.type === "playback_command" && typeof msg.sessionId === "string" && Value.Check(PlaybackCommandSchema, msg.command)) {
			const requestId = typeof msg.requestId === "string" ? msg.requestId : undefined;
			await handlePlaybackCommand(ws, msg.sessionId, msg.command, requestId, wsState.profileId, userId);
		}
	},

	onClose(ws: ProtocolSocket): void {
		const wsState = clientStates.get(ws.raw);
		if (wsState) {
			realtimeService.unregister(wsState.connectionId);
			clientStates.delete(ws.raw);
		}
	},
};

type InboundFrame = Record<string, unknown>;

function parseFrame(message: unknown): InboundFrame | null {
	if (typeof message === "string") {
		const parsed = safeParseJson(message);

		return isRecord(parsed) ? parsed : null;
	}

	return isRecord(message) ? message : null;
}

function sendPong(ws: ProtocolSocket): void {
	ws.send(JSON.stringify({ type: "pong", occurredAt: new Date().toISOString() }));
}

function sendJson(ws: ProtocolSocket, payload: Record<string, unknown>): void {
	ws.send(JSON.stringify(payload));
}

async function handleSubscribe(
	ws: ProtocolSocket,
	connectionId: string,
	sessionId: string,
	connectedProfileId: string | null,
	userId: string | undefined,
): Promise<void> {
	const { allowed, access } = await checkPlaybackSessionOwnership(sessionId, connectedProfileId, userId);
	if (!(allowed && access)) {
		sendJson(ws, { type: "session:subscribe:denied", sessionId });

		return;
	}

	// Keep the connection's registered profile immutable — the registry
	// indexes connections by it, so mutating wsState only made
	// `sendToProfile` miss this connection. Cross-profile ownership is
	// already granted through the userId branch above.
	const subscribed = realtimeService.subscribeToPlaybackSession(connectionId, sessionId);
	if (!subscribed) {
		sendJson(ws, { type: "session:subscribe:denied", sessionId, reason: "limit_reached" });

		return;
	}

	sendJson(ws, { type: "session:subscribe:confirmed", sessionId });
}

async function handlePlaybackCommand(
	ws: ProtocolSocket,
	sessionId: string,
	command: PlaybackCommand,
	requestId: string | undefined,
	connectedProfileId: string | null,
	userId: string | undefined,
): Promise<void> {
	const { allowed, access } = await checkPlaybackSessionOwnership(sessionId, connectedProfileId, userId);
	if (!(allowed && access)) {
		const error = access ? "forbidden" : "not_found";
		sendJson(ws, { type: "playback_command_error", sessionId, error, ...(requestId ? { requestId } : {}) });

		return;
	}

	// Plugin access policies (e.g. parental control) gate the HTTP command
	// route — the WS channel must not be a bypass (audit 2026-09-15).
	try {
		await assertActiveStreamAccess({ userId, profileId: access.profileId, mediaFileId: access.mediaFileId });
	} catch {
		sendJson(ws, { type: "playback_command_error", sessionId, error: "forbidden", ...(requestId ? { requestId } : {}) });

		return;
	}

	const delivered = realtimeService.sendPlaybackCommand(sessionId, command, connectedProfileId ?? access.profileId);
	sendJson(ws, {
		type: "playback_command_ack",
		sessionId,
		command: command.type,
		delivered,
		...(requestId ? { requestId } : {}),
	});
}
