import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { apiKeys } from "@/integrations/drizzle-orm/schemas/api-keys.schema";
import { users } from "@/integrations/drizzle-orm/schemas/auth.schema";
import { apiKeysService } from "@/services/admin/api-keys.service";
import { useTestDatabase } from "../helpers/test-database.helper";

const testDatabase = useTestDatabase();

async function seedUser(id: string): Promise<void> {
	const now = new Date();
	await testDatabase
		.client()
		.insert(users)
		.values({ id, name: `Creator ${id}`, email: `${id}@example.com`, emailVerified: true, createdAt: now, updatedAt: now });
}

describe("apiKeysService", () => {
	test("a created key is prefixed, authenticates to its creator, and is stored only as a hash", async () => {
		await seedUser("owner-1");
		const created = await apiKeysService.create({ name: "CI", scope: "read_only", creatorUserId: "owner-1" });

		expect(created.key.startsWith("rv_")).toBe(true);
		expect(created.keyPrefix).toBe(created.key.slice(0, 12));
		expect(await apiKeysService.authenticate(created.key)).toMatchObject({ scope: "read_only", user: { id: "owner-1" } });

		const stored = await testDatabase.client().select().from(apiKeys);
		expect(JSON.stringify(stored)).not.toContain(created.key);
	});

	test("a key that was never issued fails authentication", async () => {
		expect(await apiKeysService.authenticate("rv_not-a-real-key-value")).toBeUndefined();
	});

	test("a revoked key stops authenticating at once, and revoking it again reports not found", async () => {
		await seedUser("owner-2");
		const created = await apiKeysService.create({ name: "temp", scope: "full", creatorUserId: "owner-2" });
		expect(await apiKeysService.authenticate(created.key)).toBeDefined();

		await apiKeysService.revoke(created.id);

		expect(await apiKeysService.authenticate(created.key)).toBeUndefined();
		await expect(apiKeysService.revoke(created.id)).rejects.toMatchObject({ code: "api_key.not_found" });
	});

	test("a key past its expiry fails authentication", async () => {
		await seedUser("owner-3");
		const created = await apiKeysService.create({ name: "stale", scope: "full", expiresAtDays: 1, creatorUserId: "owner-3" });
		await testDatabase
			.client()
			.update(apiKeys)
			.set({ expiresAt: new Date(Date.now() - 86_400_000) })
			.where(eq(apiKeys.id, created.id));

		expect(await apiKeysService.authenticate(created.key)).toBeUndefined();
	});

	test("rotating a key replaces its secret: the old key stops at once, the new one authenticates, and name, scope and expiry are kept", async () => {
		await seedUser("owner-4");
		const created = await apiKeysService.create({ name: "Rotate me", scope: "full", expiresAtDays: 30, creatorUserId: "owner-4" });
		expect(await apiKeysService.authenticate(created.key)).toBeDefined();
		const expiryBefore = (await apiKeysService.list()).find((key) => key.id === created.id)?.expiresAt ?? null;

		const rotated = await apiKeysService.rotate(created.id);

		expect(rotated.key).not.toBe(created.key);
		expect(rotated).toMatchObject({ id: created.id, name: "Rotate me", scope: "full", lastUsedAt: null });
		expect(rotated.keyPrefix).toBe(rotated.key.slice(0, 12));
		expect(rotated.expiresAt).toBe(expiryBefore);
		expect(await apiKeysService.authenticate(created.key)).toBeUndefined();
		expect((await apiKeysService.authenticate(rotated.key))?.user.id).toBe("owner-4");

		const stored = await testDatabase.client().select().from(apiKeys);
		expect(stored).toHaveLength(1);
		expect(JSON.stringify(stored)).not.toContain(rotated.key);
	});

	test("renaming a key trims the name, sets or clears its expiry, and the list names the creator", async () => {
		await seedUser("owner-5");
		const created = await apiKeysService.create({ name: "Old name", scope: "read_only", creatorUserId: "owner-5" });

		const renamed = await apiKeysService.update(created.id, { name: "  New name  ", expiresAtDays: 7 });
		expect(renamed).toMatchObject({ name: "New name", createdByName: "Creator owner-5" });
		expect(renamed.expiresAt).not.toBeNull();

		const cleared = await apiKeysService.update(created.id, { expiresAtDays: null });
		expect(cleared).toMatchObject({ name: "New name", expiresAt: null });

		const listed = await apiKeysService.list();
		expect(listed.find((item) => item.id === created.id)?.createdByName).toBe("Creator owner-5");
	});

	test("updating a key refuses a blank name", async () => {
		await seedUser("owner-6");
		const created = await apiKeysService.create({ name: "Guard", scope: "read_only", creatorUserId: "owner-6" });

		await expect(apiKeysService.update(created.id, { name: "   " })).rejects.toMatchObject({ code: "api_key.name_required" });
	});

	test.each([0, 3651])("updating a key refuses an expiry of %i days", async (expiresAtDays) => {
		await seedUser("owner-7");
		const created = await apiKeysService.create({ name: "Bounds", scope: "read_only", creatorUserId: "owner-7" });

		await expect(apiKeysService.update(created.id, { expiresAtDays })).rejects.toMatchObject({ code: "api_key.expiry_invalid" });
	});

	test("rotating or updating an unknown key reports api_key.not_found", async () => {
		await expect(apiKeysService.rotate("missing")).rejects.toMatchObject({ code: "api_key.not_found" });
		await expect(apiKeysService.update("missing", { name: "x" })).rejects.toMatchObject({ code: "api_key.not_found" });
	});
});
