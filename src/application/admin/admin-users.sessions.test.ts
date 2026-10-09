import { afterEach, describe, expect, test } from "bun:test";
import { sessionsRepository } from "@/database/repositories/sessions.repository";
import { usersRepository } from "@/database/repositories/users.repository";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub";
import { adminUsersService } from "./admin-users.service";

const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("admin user sessions", () => {
	test("the session preview lists sessions without their tokens", async () => {
		stubs.push(
			stubMethod(usersRepository, "findById", () => Promise.resolve({ id: "user-1" })),
			stubMethod(sessionsRepository, "findActivePageByUserId", () =>
				Promise.resolve({
					data: [
						{
							id: "session-1",
							token: "secret-token",
							ipAddress: "10.0.0.1",
							userAgent: "Firefox",
							createdAt: new Date(1000),
							updatedAt: new Date(2000),
							expiresAt: new Date(3000),
						},
					],
					page: 1,
					limit: 25,
					total: 1,
					totalPages: 1,
				}),
			),
		);

		const page = await adminUsersService.getSessions("user-1", { page: 1, limit: 25 });

		expect(page.data).toEqual([
			{
				id: "session-1",
				ipAddress: "10.0.0.1",
				userAgent: "Firefox",
				createdAt: new Date(1000).toISOString(),
				updatedAt: new Date(2000).toISOString(),
				expiresAt: new Date(3000).toISOString(),
			},
		]);
		expect(JSON.stringify(page)).not.toContain("secret-token");
	});

	test("revoking a session the user does not have is reported as not found", async () => {
		stubs.push(stubMethod(sessionsRepository, "deleteForUser", () => Promise.resolve(false)));

		await expect(adminUsersService.revokeSession("user-1", "missing-session")).rejects.toThrow();
	});

	test("revoking several users' sessions reports how many ended", async () => {
		stubs.push(stubMethod(sessionsRepository, "deleteForUsers", () => Promise.resolve(3)));

		expect(await adminUsersService.revokeSessionsForUsers(["user-1", "user-2"])).toEqual({ revokedSessions: 3 });
	});
});
