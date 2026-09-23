import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { sessionsRepository } from "@/database/repositories/sessions.repository";
import { betterAuthApi } from "@/integrations/better-auth/better-auth.api";
import { realtimeService } from "@/modules/realtime";
import { sessionsService } from "./sessions.service";

const headers = new Headers({ cookie: "session_token=abc" });

type ActivePublicSession = Awaited<ReturnType<typeof sessionsRepository.findActivePublicByUserId>>[number];

function repoSession(id: string): ActivePublicSession {
	return {
		id,
		ipAddress: "10.0.0.1",
		userAgent: "Browser",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-02T00:00:00.000Z"),
		expiresAt: new Date("2026-02-01T00:00:00.000Z"),
	};
}

const findPage = spyOn(sessionsRepository, "findActivePageByUserId").mockResolvedValue({
	page: 1,
	limit: 20,
	total: 2,
	totalPages: 1,
	data: [],
});
const findToken = spyOn(sessionsRepository, "findTokenByIdAndUserId").mockResolvedValue("token-1");
const deleteOthers = spyOn(sessionsRepository, "deleteOtherSessions").mockResolvedValue(undefined);
const revoke = spyOn(betterAuthApi, "revokeSession").mockResolvedValue(undefined);
const sendToSession = spyOn(realtimeService, "sendToSession").mockReturnValue(undefined);

beforeEach(() => {
	findPage.mockClear().mockResolvedValue({
		page: 1,
		limit: 20,
		total: 2,
		totalPages: 1,
		data: [repoSession("session-1"), repoSession("session-2")],
	});
	findToken.mockClear().mockResolvedValue("token-1");
	deleteOthers.mockClear();
	revoke.mockClear().mockResolvedValue(undefined);
	sendToSession.mockClear();
});

describe("SessionsService.list", () => {
	test("maps rows to the public contract and flags the current session", async () => {
		const result = await sessionsService.list(headers, "session-2", "user-1", { page: 1, limit: 20 });

		expect(result.total).toBe(2);
		expect(result.data[0]).toMatchObject({ id: "session-1", isCurrent: false, ipAddress: "10.0.0.1" });
		expect(result.data[0]?.createdAt).toBe("2026-01-01T00:00:00.000Z");
		expect(result.data[1]?.isCurrent).toBe(true);
		expect(findPage).toHaveBeenCalledWith("user-1", { page: 1, limit: 20 });
	});

	test("requires headers and a user id", async () => {
		await expect(sessionsService.list(undefined, "session-2", "user-1")).rejects.toThrow("Request headers");
		await expect(sessionsService.list(headers, "session-2", undefined)).rejects.toThrow("User not found: list sessions");
	});
});

describe("SessionsService.revoke", () => {
	test("revokes another session through better auth and notifies the socket", async () => {
		const result = await sessionsService.revoke("session-2", headers, "session-1", "user-1");

		expect(result).toEqual({ success: true });
		expect(findToken).toHaveBeenCalledWith({ sessionId: "session-2", userId: "user-1" });
		expect(revoke).toHaveBeenCalledWith({ token: "token-1", headers });
		expect(sendToSession).toHaveBeenCalledWith("session-2", "auth:session:revoked", { sessionId: "session-2" });
	});

	test("refuses to revoke the current session (logout does that)", async () => {
		await expect(sessionsService.revoke("session-1", headers, "session-1", "user-1")).rejects.toThrow("logout");
		expect(revoke).not.toHaveBeenCalled();
	});

	test("throws NotFoundError for a session the user does not own", async () => {
		findToken.mockResolvedValue(undefined);
		await expect(sessionsService.revoke("session-x", headers, "session-1", "user-1")).rejects.toThrow("Session not found");
		expect(revoke).not.toHaveBeenCalled();
	});
});

describe("SessionsService.revokeOthers", () => {
	test("deletes every other session of the user", async () => {
		const result = await sessionsService.revokeOthers(headers, "session-1", "user-1");

		expect(result).toEqual({ success: true });
		expect(deleteOthers).toHaveBeenCalledWith({ userId: "user-1", currentSessionId: "session-1" });
	});

	test("requires a current session id", async () => {
		await expect(sessionsService.revokeOthers(headers, undefined, "user-1")).rejects.toThrow("Session not found: revoke other sessions");
	});
});
