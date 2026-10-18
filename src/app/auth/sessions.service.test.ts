import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { insertSessions, insertUsers, selectSessions } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { sessionsService } from "./sessions.service";

const db = useTestDatabase();
const headers = new Headers({ cookie: "session_token=abc" });
const FAR_FUTURE = new Date("2100-01-01T00:00:00.000Z");

/** Better Auth's revoke needs a signed session cookie; the stub only records the token it was given. */
let revokeStub: MethodStub;
const connectionIds: string[] = [];

beforeEach(async () => {
	await seedSessions();
	revokeStub = stubMethod(betterAuthApi, "revokeSession", () => Promise.resolve());
});

afterEach(() => {
	revokeStub.restore();
	for (const connectionId of connectionIds.splice(0)) realtimeService.unregister(connectionId);
});

/** Ann owns three sessions (one expired); Ben owns one. */
async function seedSessions(): Promise<void> {
	const client = db.client();
	await insertUsers(client, [
		{ id: "user-1", name: "Ann", email: "ann@example.com", emailVerified: true },
		{ id: "user-2", name: "Ben", email: "ben@example.com", emailVerified: true },
	]);
	const session = (id: string, userId: string, expiresAt: Date) => ({
		id,
		userId,
		token: `token-${id}`,
		ipAddress: "10.0.0.1",
		userAgent: "Browser",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-02T00:00:00.000Z"),
		expiresAt,
	});
	await insertSessions(client, [
		session("session-1", "user-1", FAR_FUTURE),
		session("session-2", "user-1", FAR_FUTURE),
		session("session-old", "user-1", new Date("2020-01-01T00:00:00.000Z")),
		session("session-x", "user-2", FAR_FUTURE),
	]);
}

async function sessionIds(): Promise<string[]> {
	const rows = await selectSessions(db.client());

	return rows.map((row) => row.id).toSorted();
}

/** Registers a realtime connection for an auth session and records what the server writes to it. */
function connect(connectionId: string, userId: string, sessionId: string) {
	const messages: string[] = [];
	const closes: Array<{ code: number | undefined; reason: string | undefined }> = [];
	realtimeService.register({
		connectionId,
		userId,
		sessionId,
		socket: {
			send: (message) => {
				messages.push(message);

				return 1;
			},
			close: (code, reason) => {
				closes.push({ code, reason });
			},
		},
	});
	connectionIds.push(connectionId);

	return { messages, closes };
}

function connectSockets() {
	return {
		current: connect("conn-current", "user-1", "session-1"),
		other: connect("conn-other", "user-1", "session-2"),
		stranger: connect("conn-stranger", "user-2", "session-x"),
	};
}

function messageTypes(messages: string[]): string[] {
	return messages.map((message) => JSON.parse(message).type);
}

describe("SessionsService.list", () => {
	test("lists the caller's unexpired sessions and marks only the current one", async () => {
		const result = await sessionsService.list(headers, "session-1", "user-1");

		expect(Object.fromEntries(result.data.map((session) => [session.id, session.isCurrent]))).toEqual({
			"session-1": true,
			"session-2": false,
		});
	});
});

describe("SessionsService.revoke", () => {
	test("refuses to revoke the current session and leaves its socket open", async () => {
		const sockets = connectSockets();

		await expect(sessionsService.revoke("session-1", headers, "session-1", "user-1")).rejects.toMatchObject({
			category: "forbidden",
			code: "auth.current_session_revoke_forbidden",
		});
		expect(revokeStub.calls).toEqual([]);
		expect(sockets.current.closes).toEqual([]);
	});

	test("refuses to revoke another user's session as not found", async () => {
		const sockets = connectSockets();

		await expect(sessionsService.revoke("session-x", headers, "session-1", "user-1")).rejects.toMatchObject({
			category: "not_found",
			code: "auth.session_not_found",
		});
		expect(revokeStub.calls).toEqual([]);
		expect(sockets.stranger.closes).toEqual([]);
	});

	test("revokes the owned session's token through Better Auth and closes only its sockets", async () => {
		const sockets = connectSockets();

		await expect(sessionsService.revoke("session-2", headers, "session-1", "user-1")).resolves.toEqual({ success: true });

		expect(revokeStub.calls).toEqual([[{ token: "token-session-2", headers }]]);
		expect(messageTypes(sockets.other.messages)).toEqual(["auth:session:revoked"]);
		expect(sockets.other.closes).toEqual([{ code: 4001, reason: "Session revoked" }]);
		expect(sockets.current.closes).toEqual([]);
		expect(sockets.stranger.closes).toEqual([]);
	});
});

describe("SessionsService.revokeOthers", () => {
	test("deletes the caller's other sessions and keeps the current one and other users' sessions", async () => {
		await expect(sessionsService.revokeOthers(headers, "session-1", "user-1")).resolves.toEqual({ success: true });

		expect(await sessionIds()).toEqual(["session-1", "session-x"]);
	});

	test("closes the other sockets of the caller and leaves the current session's socket open", async () => {
		const sockets = connectSockets();

		await sessionsService.revokeOthers(headers, "session-1", "user-1");

		expect(sockets.other.closes).toEqual([{ code: 4001, reason: "Session revoked" }]);
		expect(sockets.current.closes).toEqual([]);
		expect(sockets.stranger.closes).toEqual([]);
	});
});

describe("anonymous callers", () => {
	test("refuses list, revoke and revoke-others without a user and deletes nothing", async () => {
		await expect(sessionsService.list(headers, "session-1", undefined)).rejects.toMatchObject({
			category: "unauthorized",
			code: "auth.user_required",
		});
		await expect(sessionsService.revoke("session-2", headers, "session-1", undefined)).rejects.toMatchObject({
			category: "unauthorized",
			code: "auth.user_required",
		});
		await expect(sessionsService.revokeOthers(headers, "session-1", undefined)).rejects.toMatchObject({
			category: "unauthorized",
			code: "auth.user_required",
		});

		expect(await sessionIds()).toEqual(["session-1", "session-2", "session-old", "session-x"]);
	});
});
