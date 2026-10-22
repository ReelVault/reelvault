import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { env } from "@/config/env.config";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { type ProtocolSocket, wsProtocol } from "@/modules/realtime/ws-protocol.service";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { createMockPlaybackDecision } from "@/modules/streaming/streaming.helper";
import { profilesRepository } from "@/repositories/profiles.repository";
import { profilePinFingerprint, signProfileUnlock } from "@/utils/profile-unlock.utils";
import { useTestDatabase } from "../helpers/test-database.helper";

/**
 * Realtime socket protocol: the profile chosen at the upgrade, playback-session
 * subscriptions and control commands must follow the same ownership rules as HTTP.
 * Frames that are oversized, malformed or sent before the connection registered are
 * dropped without effect, and a flood closes the socket. Profiles live in the test
 * database and sessions in the real streaming runtime; only the socket is a double,
 * and assertions read the frames a client would receive.
 */

const db = useTestDatabase();

const OWNER = { userId: "user-owner", profileId: "profile-owner" };
const STRANGER = { userId: "user-stranger", profileId: "profile-stranger" };
const LOCKED = { userId: OWNER.userId, profileId: "profile-owner-locked" };
const LOCKED_PIN = "hash";
const PROFILE_IDS = [OWNER.profileId, STRANGER.profileId, LOCKED.profileId];
const decision = createMockPlaybackDecision({ mode: "direct-stream", videoTranscode: false, audioTranscode: false, reason: "test" });

beforeEach(async () => {
	const client = db.client();
	await client.insert(schema.users).values([
		{ id: OWNER.userId, name: "owner", email: "owner@example.com", emailVerified: true },
		{ id: STRANGER.userId, name: "stranger", email: "stranger@example.com", emailVerified: true },
	]);
	await client.insert(schema.profiles).values([
		{ id: OWNER.profileId, userId: OWNER.userId, name: "Owner" },
		{ id: STRANGER.profileId, userId: STRANGER.userId, name: "Stranger" },
		{ id: LOCKED.profileId, userId: LOCKED.userId, name: "Locked", pin: LOCKED_PIN },
	]);
	for (const profileId of PROFILE_IDS) profilesRepository.invalidateCached(profileId);
});

interface SocketDouble {
	socket: ProtocolSocket;
	sent: string[];
	closed: Array<{ code: number; reason: string }>;
}

function socketDouble(): SocketDouble {
	const sent: string[] = [];
	const closed: Array<{ code: number; reason: string }> = [];
	const socket: ProtocolSocket = {
		raw: {
			send(data: string) {
				sent.push(data);

				return 1;
			},
			close(code?: number, reason?: string) {
				closed.push({ code: code ?? 0, reason: reason ?? "" });
			},
		},
		send(data: string) {
			sent.push(data);

			return 1;
		},
		close(code: number, reason: string) {
			closed.push({ code, reason });
		},
	};

	return { socket, sent, closed };
}

const sockets: ProtocolSocket[] = [];
const sessionIds: string[] = [];

/** Opens a connection the way the upgrade does, so the registry holds it until the test ends. */
function connect(profile: { userId: string; profileId: string | null }): SocketDouble {
	const double = socketDouble();
	sockets.push(double.socket);
	wsProtocol.onOpen(double.socket, { userId: profile.userId, profileId: profile.profileId, sessionId: null });

	return double;
}

function openSession(profileId: string): string {
	const sessionId = `session-${crypto.randomUUID()}`;
	sessionIds.push(sessionId);
	streamingManager.registerSession(sessionId, {
		mediaFileId: `media-${crypto.randomUUID()}`,
		profileId,
		decision,
		inputPath: "/media/ws.mkv",
	});

	return sessionId;
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) wsProtocol.onClose(socket);
	await Promise.all(sessionIds.splice(0).map(async (sessionId) => await streamingManager.discardSession(sessionId)));
});

const subscribe = (sessionId: string) => JSON.stringify({ type: "subscribe_session", sessionId });
const framesOf = (sent: string[]): unknown[] => sent.map((frame) => JSON.parse(frame));

describe("handshake profile", () => {
	test("a profile the account does not own is refused with profile.not_owned", async () => {
		await expect(wsProtocol.assertHandshakeProfile(OWNER.userId, STRANGER.profileId, undefined)).rejects.toMatchObject({
			code: "profile.not_owned",
		});
	});

	test("a PIN-protected profile needs a valid unlock token even for its owner", async () => {
		await expect(wsProtocol.assertHandshakeProfile(OWNER.userId, LOCKED.profileId, undefined)).rejects.toMatchObject({
			code: "auth.profile_locked",
		});
		await expect(wsProtocol.assertHandshakeProfile(OWNER.userId, LOCKED.profileId, "forged-token")).rejects.toMatchObject({
			code: "auth.profile_locked",
		});
	});

	test("a PIN-protected profile opens with a genuine unlock token for that profile", async () => {
		const token = signProfileUnlock(LOCKED.profileId, env.BETTER_AUTH_SECRET, profilePinFingerprint(LOCKED_PIN));

		await expect(wsProtocol.assertHandshakeProfile(OWNER.userId, LOCKED.profileId, token)).resolves.toBeUndefined();
	});

	test("an unlock token issued for another profile does not open this one", async () => {
		// The fingerprint matches, so only the profile binding can refuse this token.
		const tokenForOtherProfile = signProfileUnlock("profile-someone-else", env.BETTER_AUTH_SECRET, profilePinFingerprint(LOCKED_PIN));

		await expect(wsProtocol.assertHandshakeProfile(OWNER.userId, LOCKED.profileId, tokenForOtherProfile)).rejects.toMatchObject({
			code: "auth.profile_locked",
		});
	});

	test("an unlock token issued before the PIN changed no longer opens the profile", async () => {
		const tokenForOldPin = signProfileUnlock(LOCKED.profileId, env.BETTER_AUTH_SECRET, profilePinFingerprint("previous-hash"));

		await expect(wsProtocol.assertHandshakeProfile(OWNER.userId, LOCKED.profileId, tokenForOldPin)).rejects.toMatchObject({
			code: "auth.profile_locked",
		});
	});

	test("an unlock token signed with another secret does not open the profile", async () => {
		const forgedToken = signProfileUnlock(LOCKED.profileId, "not-the-server-secret", profilePinFingerprint(LOCKED_PIN));

		await expect(wsProtocol.assertHandshakeProfile(OWNER.userId, LOCKED.profileId, forgedToken)).rejects.toMatchObject({
			code: "auth.profile_locked",
		});
	});
});

describe("playback session subscriptions", () => {
	test("a connection subscribes to a session of its own profile", async () => {
		const sessionId = openSession(OWNER.profileId);
		const { socket, sent } = connect({ userId: OWNER.userId, profileId: OWNER.profileId });

		await wsProtocol.onMessage(socket, subscribe(sessionId), OWNER.userId);

		expect(framesOf(sent)).toEqual([{ type: "session:subscribe:confirmed", sessionId }]);
	});

	test("a connection cannot subscribe to another account's playback session", async () => {
		const foreignSessionId = openSession(STRANGER.profileId);
		const { socket, sent } = connect({ userId: OWNER.userId, profileId: OWNER.profileId });

		await wsProtocol.onMessage(socket, subscribe(foreignSessionId), OWNER.userId);

		expect(framesOf(sent)).toEqual([{ type: "session:subscribe:denied", sessionId: foreignSessionId }]);
	});

	test("an unknown session id is denied the same way as a foreign one", async () => {
		const { socket, sent } = connect({ userId: OWNER.userId, profileId: OWNER.profileId });

		await wsProtocol.onMessage(socket, subscribe("missing-session"), OWNER.userId);

		expect(framesOf(sent)).toEqual([{ type: "session:subscribe:denied", sessionId: "missing-session" }]);
	});

	test("a session of the owner's PIN-protected profile is denied to an account-level connection", async () => {
		const lockedSessionId = openSession(LOCKED.profileId);
		const { socket, sent } = connect({ userId: OWNER.userId, profileId: null });

		await wsProtocol.onMessage(socket, subscribe(lockedSessionId), OWNER.userId);

		expect(framesOf(sent)).toEqual([{ type: "session:subscribe:denied", sessionId: lockedSessionId }]);
	});

	test("a connection unlocked for the PIN-protected profile subscribes to its session", async () => {
		const lockedSessionId = openSession(LOCKED.profileId);
		const { socket, sent } = connect({ userId: OWNER.userId, profileId: LOCKED.profileId });

		await wsProtocol.onMessage(socket, subscribe(lockedSessionId), OWNER.userId);

		expect(framesOf(sent)).toEqual([{ type: "session:subscribe:confirmed", sessionId: lockedSessionId }]);
	});
});

describe("frame handling", () => {
	test("frames sent before the connection registered have no effect", async () => {
		const sessionId = openSession(OWNER.profileId);
		const { socket, sent } = socketDouble();

		await wsProtocol.onMessage(socket, subscribe(sessionId), OWNER.userId);

		expect(sent).toEqual([]);
	});

	test("ignores a frame over the inbound size limit even when it carries a valid subscription", async () => {
		const sessionId = openSession(OWNER.profileId);
		const { socket, sent } = connect({ userId: OWNER.userId, profileId: OWNER.profileId });
		const padded = JSON.stringify({ type: "subscribe_session", sessionId, padding: "x".repeat(20_000) });

		await wsProtocol.onMessage(socket, padded, OWNER.userId);

		expect(sent).toEqual([]);
	});

	test("malformed frames and unknown types are ignored without an error reply", async () => {
		const { socket, sent, closed } = connect({ userId: OWNER.userId, profileId: OWNER.profileId });

		for (const frame of ["{not json", "[]", "null", JSON.stringify({ type: 42 }), JSON.stringify({ type: "unknown" }), "\u0000\u0001"]) {
			await wsProtocol.onMessage(socket, frame, OWNER.userId);
		}

		expect(sent).toEqual([]);
		expect(closed).toEqual([]);
	});

	test("ping answers with a pong frame in both encodings", async () => {
		const { socket, sent } = connect({ userId: OWNER.userId, profileId: OWNER.profileId });

		await wsProtocol.onMessage(socket, "ping", OWNER.userId);
		await wsProtocol.onMessage(socket, JSON.stringify({ type: "ping" }), OWNER.userId);

		expect(framesOf(sent)).toMatchObject([{ type: "pong" }, { type: "pong" }]);
	});

	test("a flood of frames closes the socket with a policy code", async () => {
		const sessionId = openSession(OWNER.profileId);
		const { socket, closed } = connect({ userId: OWNER.userId, profileId: OWNER.profileId });
		const frame = JSON.stringify({ type: "unsubscribe_session", sessionId });

		for (let index = 0; index < 400; index += 1) {
			await wsProtocol.onMessage(socket, frame, OWNER.userId);
		}

		expect(closed.map((entry) => entry.code)).toContain(1008);
	});
});
