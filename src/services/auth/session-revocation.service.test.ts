import { afterEach, describe, expect, test } from "bun:test";
import { getOrSetSession, invalidateSessionCache } from "@/integrations/better-auth/better-auth.session-cache";
import { insertSessions, insertUsers, selectSessions } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { revokeUserSession, revokeUserSessions } from "./session-revocation.service";

const db = useTestDatabase();

afterEach(() => {
	invalidateSessionCache();
});

async function seedUsers(): Promise<void> {
	await insertUsers(db.client(), [
		{ id: "user-1", name: "Alice", email: "alice@example.test", emailVerified: true },
		{ id: "user-2", name: "Bob", email: "bob@example.test", emailVerified: true },
	]);
}

describe("session revocation", () => {
	test("a revoked user's session is read from the database again on the next request", async () => {
		await seedUsers();
		await insertSessions(db.client(), { id: "s-1", userId: "user-1", token: "token-1", expiresAt: new Date(Date.now() + 60_000) });
		let reads = 0;
		const readSession = () => {
			reads += 1;

			return Promise.resolve(null);
		};
		await getOrSetSession("token-1", readSession);

		await revokeUserSessions(["user-1"]);
		await getOrSetSession("token-1", readSession);

		expect(reads).toBe(2);
		expect(await selectSessions(db.client())).toEqual([]);
	});

	test("ending one session leaves the other sessions of the user in place", async () => {
		await seedUsers();
		await insertSessions(db.client(), { id: "s-1", userId: "user-1", token: "token-1", expiresAt: new Date(Date.now() + 60_000) });
		await insertSessions(db.client(), { id: "s-2", userId: "user-1", token: "token-2", expiresAt: new Date(Date.now() + 60_000) });

		expect(await revokeUserSession("user-1", "s-1")).toBe(true);

		expect((await selectSessions(db.client())).map((row) => row.id)).toEqual(["s-2"]);
	});

	test("ending a session of another user reports nothing revoked and keeps it", async () => {
		await seedUsers();
		await insertSessions(db.client(), { id: "s-2", userId: "user-2", token: "token-2", expiresAt: new Date(Date.now() + 60_000) });

		expect(await revokeUserSession("user-1", "s-2")).toBe(false);

		expect((await selectSessions(db.client())).map((row) => row.id)).toEqual(["s-2"]);
	});
});
