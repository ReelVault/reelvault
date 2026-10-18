import { beforeEach, describe, expect, test } from "bun:test";
import { insertSessions, insertUsers, selectSessions } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { adminUsersService } from "./admin-users.service";

const { client } = useTestDatabase();

// Stored timestamps have whole-second precision, so the fixtures are aligned to a second.
const NOW = Math.floor(Date.now() / 1000) * 1000;
const HOUR = 60 * 60_000;

beforeEach(async () => {
	await insertUsers(client(), [
		{ id: "user-1", name: "User", email: "user@example.com", emailVerified: true },
		{ id: "user-2", name: "Other", email: "other@example.com", emailVerified: true },
	]);
});

describe("admin user sessions", () => {
	test("the session preview lists active sessions without their tokens", async () => {
		await insertSessions(client(), {
			id: "session-1",
			userId: "user-1",
			token: "secret-token",
			ipAddress: "10.0.0.1",
			userAgent: "Firefox",
			expiresAt: new Date(NOW + HOUR),
			createdAt: new Date(NOW - 1000),
			updatedAt: new Date(NOW - 2000),
		});

		const page = await adminUsersService.getSessions("user-1", { page: 1, limit: 25 });

		expect(page.data).toEqual([
			{
				id: "session-1",
				ipAddress: "10.0.0.1",
				userAgent: "Firefox",
				createdAt: new Date(NOW - 1000).toISOString(),
				updatedAt: new Date(NOW - 2000).toISOString(),
				expiresAt: new Date(NOW + HOUR).toISOString(),
			},
		]);
		expect(JSON.stringify(page)).not.toContain("secret-token");
	});

	test("revoking another user's session is reported as not found and leaves it in place", async () => {
		await insertSessions(client(), { id: "session-2", userId: "user-2", token: "other-token", expiresAt: new Date(NOW + HOUR) });

		await expect(adminUsersService.revokeSession("user-1", "session-2")).rejects.toMatchObject({
			category: "not_found",
			code: "entity.not_found",
		});
		expect((await selectSessions(client())).map((row) => row.id)).toEqual(["session-2"]);
	});
});
