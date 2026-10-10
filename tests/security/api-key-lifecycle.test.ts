import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { apiKeysService } from "@/application/admin/api-keys.service";
import { databaseFactory } from "@/database/database";
import { apiKeys } from "@/database/schemas/api-keys.schema";
import { users } from "@/database/schemas/auth.schema";
import { prepareSecuritySuite, send } from "./security-harness";

/**
 * API keys act as their creator for every request, so their lifecycle has to follow the
 * creator's account: a blocked account loses its keys at once, revoked and rotated
 * secrets stop working immediately (the authentication cache is cleared on every change),
 * expired keys are refused, and read-only keys cannot write.
 */

prepareSecuritySuite();

const client = databaseFactory.getClient();

async function seedUser(role: "admin" | "user"): Promise<string> {
	const id = `key-owner-${crypto.randomUUID()}`;
	const now = new Date();
	await client.insert(users).values({
		id,
		name: id,
		email: `${id}@example.test`,
		emailVerified: true,
		role,
		banned: false,
		createdAt: now,
		updatedAt: now,
	});

	return id;
}

async function createKey(creatorUserId: string, scope: "full" | "read_only", expiresAtDays?: number): Promise<{ id: string; key: string }> {
	const created = await apiKeysService.create({ name: `key-${scope}`, scope, creatorUserId, expiresAtDays });

	return { id: created.id, key: created.key };
}

async function callAdminAudit(apiKey: string): Promise<Response> {
	return await send("GET", "/v1/admin/audit", { headers: { "x-api-key": apiKey } });
}

beforeEach(async () => {
	await client.delete(apiKeys);
	await client.delete(users);
});

describe("API key lifecycle", () => {
	test("an administrator's full-scope key opens administrator routes", async () => {
		const adminId = await seedUser("admin");
		const { key } = await createKey(adminId, "full");

		const response = await callAdminAudit(key);

		expect(response.status).toBe(200);
	});

	test("a blocked account loses its API keys immediately", async () => {
		const adminId = await seedUser("admin");
		const { key } = await createKey(adminId, "full");
		await client.update(users).set({ banned: true, banReason: "test block", banExpires: null }).where(eq(users.id, adminId));

		const response = await callAdminAudit(key);

		expect([401, 403]).toContain(response.status);
	});

	test("a temporary block that has already expired does not lock the account out", async () => {
		const adminId = await seedUser("admin");
		const { key } = await createKey(adminId, "full");
		await client
			.update(users)
			.set({ banned: true, banReason: "expired block", banExpires: new Date(Date.now() - 60_000) })
			.where(eq(users.id, adminId));

		const response = await callAdminAudit(key);

		expect(response.status).toBe(200);
	});

	test("a revoked key stops working on the next request, not after the cache expires", async () => {
		const adminId = await seedUser("admin");
		const { id, key } = await createKey(adminId, "full");
		expect((await callAdminAudit(key)).status).toBe(200);

		await apiKeysService.revoke(id);

		expect([401, 403]).toContain((await callAdminAudit(key)).status);
	});

	test("a rotated key's old secret is refused at once and the new secret works", async () => {
		const adminId = await seedUser("admin");
		const { id, key: oldKey } = await createKey(adminId, "full");
		expect((await callAdminAudit(oldKey)).status).toBe(200);

		const rotated = await apiKeysService.rotate(id);

		expect([401, 403]).toContain((await callAdminAudit(oldKey)).status);
		expect((await callAdminAudit(rotated.key)).status).toBe(200);
	});

	test("an expired key is refused even though it still exists", async () => {
		const adminId = await seedUser("admin");
		const { id, key } = await createKey(adminId, "full", 1);
		await client
			.update(apiKeys)
			.set({ expiresAt: new Date(Date.now() - 60_000) })
			.where(eq(apiKeys.id, id));

		expect([401, 403]).toContain((await callAdminAudit(key)).status);
	});

	test("a read-only key cannot write, even on a route the administrator may use", async () => {
		const adminId = await seedUser("admin");
		const { key } = await createKey(adminId, "read_only");

		const response = await send("POST", "/v1/admin/api-keys", { headers: { "x-api-key": key }, body: { name: "escalate", scope: "full" } });

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: "api_key.read_only" });
	});

	test("a key with a malformed or unknown secret is refused", async () => {
		await seedUser("admin");

		for (const bogus of ["rv_", "rv_0000000000000000000000000000000000000000", "not-a-key", "rv_ spaced value"]) {
			const response = await callAdminAudit(bogus);
			expect([401, 403]).toContain(response.status);
		}
	});
});
