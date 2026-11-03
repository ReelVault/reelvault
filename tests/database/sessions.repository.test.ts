import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { sessions, users } from "@/integrations/drizzle-orm/schemas/auth.schema";
import { sessionsRepository } from "@/repositories/sessions.repository";
import { useTestDatabase } from "../helpers/test-database.helper";

const testDatabase = useTestDatabase();

async function seedUser(id: string): Promise<void> {
	const now = new Date();
	await testDatabase
		.client()
		.insert(users)
		.values({ id, name: `User ${id}`, email: `${id}@example.com`, emailVerified: true, createdAt: now, updatedAt: now });
}

describe("sessionsRepository.deleteExpired", () => {
	test("removes only the sessions whose expiry is before the cutoff", async () => {
		await seedUser("session-owner");
		const now = new Date("2026-01-01T00:00:00.000Z");
		const longAgo = new Date("2025-12-01T00:00:00.000Z");
		const later = new Date("2026-02-01T00:00:00.000Z");
		await testDatabase
			.client()
			.insert(sessions)
			.values([
				{ id: "expired", token: "expired-token", userId: "session-owner", expiresAt: longAgo, createdAt: longAgo, updatedAt: longAgo },
				{ id: "active", token: "active-token", userId: "session-owner", expiresAt: later, createdAt: now, updatedAt: now },
			]);

		expect(await sessionsRepository.deleteExpired(now)).toBe(1);

		const remaining = await testDatabase.client().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, "session-owner"));
		expect(remaining).toEqual([{ id: "active" }]);
	});
});
