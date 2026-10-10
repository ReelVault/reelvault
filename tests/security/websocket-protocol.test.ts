import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { profilesRepository } from "@/database/repositories/profiles.repository";
import { env } from "@/env";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { type ProtocolSocket, wsProtocol } from "@/modules/realtime/ws-protocol.service";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { profilePinFingerprint, signProfileUnlock } from "@/utils/profile-unlock.utils";
import { stubMethod } from "../helpers/method-stub";

/**
 * Realtime socket protocol: the profile chosen at the upgrade, playback-session
 * subscriptions and control commands must follow the same ownership rules as HTTP.
 * Frames that are oversized, malformed or sent before the connection registered are
 * dropped without effect, and a flood closes the socket.
 */

function socketDouble(): { socket: ProtocolSocket; sent: string[]; closed: Array<{ code: number; reason: string }> } {
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

const OWNER = { userId: "user-owner", profileId: "profile-owner" };
const STRANGER = { userId: "user-stranger", profileId: "profile-stranger" };
const SESSION_OF_OWNER = "session-owner-1";
const SESSION_OF_STRANGER = "session-stranger-1";
const SESSION_OF_LOCKED_PROFILE = "session-locked-1";
const LOCKED_PIN = "hash";

const activeStubs: Array<{ restore(): void }> = [];
let subscriptions: Array<{ connectionId: string; sessionId: string }> = [];

beforeEach(() => {
	subscriptions = [];
	activeStubs.push(
		stubMethod(streamingManager, "getSessionAccess", (sessionId: string) => {
			if (sessionId === SESSION_OF_OWNER) return { mediaFileId: "mf-1", profileId: OWNER.profileId };
			if (sessionId === SESSION_OF_STRANGER) return { mediaFileId: "mf-2", profileId: STRANGER.profileId };
			if (sessionId === SESSION_OF_LOCKED_PROFILE) return { mediaFileId: "mf-3", profileId: "profile-owner-locked" };

			return undefined;
		}),
		stubMethod(profilesRepository, "findByPrimaryIdCached", (profileId: string) => {
			if (profileId === OWNER.profileId) return { id: OWNER.profileId, userId: OWNER.userId, name: "Owner", pin: null };
			if (profileId === STRANGER.profileId) return { id: STRANGER.profileId, userId: STRANGER.userId, name: "Stranger", pin: null };
			if (profileId === "profile-owner-locked") return { id: profileId, userId: OWNER.userId, name: "Locked", pin: LOCKED_PIN };

			return undefined;
		}),
		stubMethod(realtimeService, "subscribeToPlaybackSession", (connectionId: string, sessionId: string) => {
			subscriptions.push({ connectionId, sessionId });

			return true;
		}),
		stubMethod(realtimeService, "register", () => undefined),
		stubMethod(realtimeService, "unregister", () => undefined),
		stubMethod(realtimeService, "touch", () => undefined),
		stubMethod(realtimeService, "unsubscribeFromPlaybackSession", () => undefined),
	);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

describe("handshake profile", () => {
	test("a profile the account does not own is refused with profile.not_owned", async () => {
		await expect(wsProtocol.assertHandshakeProfile(OWNER.userId, STRANGER.profileId, undefined)).rejects.toMatchObject({
			code: "profile.not_owned",
		});
	});

	test("a PIN-protected profile needs a valid unlock token even for its owner", async () => {
		await expect(wsProtocol.assertHandshakeProfile(OWNER.userId, "profile-owner-locked", undefined)).rejects.toMatchObject({
			code: "auth.profile_locked",
		});
		await expect(wsProtocol.assertHandshakeProfile(OWNER.userId, "profile-owner-locked", "forged-token")).rejects.toMatchObject({
			code: "auth.profile_locked",
		});
	});

	test("a PIN-protected profile opens with a genuine unlock token for that profile", async () => {
		const token = signProfileUnlock("profile-owner-locked", env.BETTER_AUTH_SECRET, profilePinFingerprint(LOCKED_PIN));
		await expect(wsProtocol.assertHandshakeProfile(OWNER.userId, "profile-owner-locked", token)).resolves.toBeUndefined();
	});

	test("an unlock token issued for another profile does not open this one", async () => {
		const tokenForOtherProfile = signProfileUnlock("profile-someone-else", env.BETTER_AUTH_SECRET, "fingerprint");
		await expect(wsProtocol.assertHandshakeProfile(OWNER.userId, "profile-owner-locked", tokenForOtherProfile)).rejects.toMatchObject({
			code: "auth.profile_locked",
		});
	});
});

describe("playback session subscriptions", () => {
	test("a connection can subscribe to a session of its own profile", async () => {
		const { socket, sent } = socketDouble();
		wsProtocol.onOpen(socket, { userId: OWNER.userId, profileId: OWNER.profileId, sessionId: null });

		await wsProtocol.onMessage(socket, JSON.stringify({ type: "subscribe_session", sessionId: SESSION_OF_OWNER }), OWNER.userId);

		expect(subscriptions.map((entry) => entry.sessionId)).toEqual([SESSION_OF_OWNER]);
		expect(sent.some((frame) => frame.includes("session:subscribe:denied"))).toBe(false);
	});

	test("a connection cannot subscribe to another account's playback session", async () => {
		const { socket, sent } = socketDouble();
		wsProtocol.onOpen(socket, { userId: OWNER.userId, profileId: OWNER.profileId, sessionId: null });

		await wsProtocol.onMessage(socket, JSON.stringify({ type: "subscribe_session", sessionId: SESSION_OF_STRANGER }), OWNER.userId);

		expect(subscriptions).toEqual([]);
		expect(sent.some((frame) => frame.includes("session:subscribe:denied"))).toBe(true);
	});

	test("an unknown session id is denied the same way, without revealing whether it exists", async () => {
		const { socket, sent } = socketDouble();
		wsProtocol.onOpen(socket, { userId: OWNER.userId, profileId: OWNER.profileId, sessionId: null });

		await wsProtocol.onMessage(socket, JSON.stringify({ type: "subscribe_session", sessionId: "missing-session" }), OWNER.userId);

		expect(subscriptions).toEqual([]);
		expect(sent.some((frame) => frame.includes("session:subscribe:denied") && frame.includes("missing-session"))).toBe(true);
	});

	test("a session of the owner's PIN-protected profile is denied to an account-level connection", async () => {
		const { socket, sent } = socketDouble();
		wsProtocol.onOpen(socket, { userId: OWNER.userId, profileId: null, sessionId: null });

		await wsProtocol.onMessage(socket, JSON.stringify({ type: "subscribe_session", sessionId: SESSION_OF_LOCKED_PROFILE }), OWNER.userId);

		expect(subscriptions).toEqual([]);
		expect(sent.some((frame) => frame.includes("session:subscribe:denied"))).toBe(true);
	});
});

describe("frame handling", () => {
	test("frames sent before the connection registered have no effect", async () => {
		const { socket, sent } = socketDouble();

		await wsProtocol.onMessage(socket, JSON.stringify({ type: "subscribe_session", sessionId: SESSION_OF_OWNER }), OWNER.userId);

		expect(subscriptions).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("oversized frames are dropped before parsing", async () => {
		const { socket, sent } = socketDouble();
		wsProtocol.onOpen(socket, { userId: OWNER.userId, profileId: OWNER.profileId, sessionId: null });
		const padded = JSON.stringify({ type: "subscribe_session", sessionId: SESSION_OF_OWNER, padding: "x".repeat(20_000) });

		await wsProtocol.onMessage(socket, padded, OWNER.userId);

		expect(subscriptions).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("malformed frames and unknown types are ignored without an error reply", async () => {
		const { socket, sent, closed } = socketDouble();
		wsProtocol.onOpen(socket, { userId: OWNER.userId, profileId: OWNER.profileId, sessionId: null });

		for (const frame of ["{not json", "[]", "null", JSON.stringify({ type: 42 }), JSON.stringify({ type: "unknown" }), "\u0000\u0001"]) {
			await wsProtocol.onMessage(socket, frame, OWNER.userId);
		}

		expect(subscriptions).toEqual([]);
		expect(sent).toEqual([]);
		expect(closed).toEqual([]);
	});

	test("ping answers with a pong frame in both encodings", async () => {
		const { socket, sent } = socketDouble();
		wsProtocol.onOpen(socket, { userId: OWNER.userId, profileId: OWNER.profileId, sessionId: null });

		await wsProtocol.onMessage(socket, "ping", OWNER.userId);
		await wsProtocol.onMessage(socket, JSON.stringify({ type: "ping" }), OWNER.userId);

		expect(sent.length).toBe(2);
		expect(sent.every((frame) => frame.includes("pong"))).toBe(true);
	});

	test("a flood of frames closes the socket with a rate-limit code", async () => {
		const { socket, closed } = socketDouble();
		wsProtocol.onOpen(socket, { userId: OWNER.userId, profileId: OWNER.profileId, sessionId: null });
		const frame = JSON.stringify({ type: "unsubscribe_session", sessionId: SESSION_OF_OWNER });

		for (let index = 0; index < 400; index += 1) {
			await wsProtocol.onMessage(socket, frame, OWNER.userId);
		}

		expect(closed.some((entry) => entry.code === 1008)).toBe(true);
	});
});
