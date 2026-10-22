import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { insertSessions, insertUsers, selectSessions } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { adminUsersService } from "./admin-users.service";

const { client } = useTestDatabase();

// The preview keeps the sessions that have not expired yet, so the clock is pinned to a fixed instant.
// Stored timestamps have whole-second precision, so every fixture sits on a whole second.
const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const HOUR = 60 * 60_000;

beforeEach(async () => {
	setSystemTime(new Date(NOW));
	await insertUsers(client(), [
		{ id: "user-1", name: "User", email: "user@example.com", emailVerified: true },
		{ id: "user-2", name: "Other", email: "other@example.com", emailVerified: true },
	]);
});

afterEach(() => {
	setSystemTime();
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
				createdAt: "2026-01-01T11:59:59.000Z",
				updatedAt: "2026-01-01T11:59:58.000Z",
				expiresAt: "2026-01-01T13:00:00.000Z",
			},
		]);
		expect(JSON.stringify(page)).not.toContain("secret-token");
	});

	test("the session preview leaves out a session whose expiry has passed", async () => {
		await insertSessions(client(), { id: "session-1", userId: "user-1", token: "live-token", expiresAt: new Date(NOW + HOUR) });
		await insertSessions(client(), { id: "session-expired", userId: "user-1", token: "old-token", expiresAt: new Date(NOW - 1000) });

		const page = await adminUsersService.getSessions("user-1", { page: 1, limit: 25 });

		expect(page.data.map((session) => session.id)).toEqual(["session-1"]);
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
