import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { apiKeysService } from "@/application/admin/api-keys.service";
import { databaseFactory } from "@/database/database";
import { apiKeys } from "@/database/schemas/api-keys.schema";
import { users } from "@/database/schemas/auth.schema";

const client = databaseFactory.getClient();

async function seedUser(id: string): Promise<void> {
	await client
		.insert(users)
		.values({ id, name: `owner-${id}`, email: `${id}@example.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
}

beforeAll(async () => {
	// Column names mirror auth.schema (better-auth keeps camelCase column names).
	await client.run(
		sql.raw(`
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			email TEXT NOT NULL,
			"emailVerified" INTEGER NOT NULL DEFAULT false,
			image TEXT,
			role TEXT NOT NULL DEFAULT 'user',
			banned INTEGER NOT NULL DEFAULT false,
			"banReason" TEXT,
			"banExpires" INTEGER,
			"twoFactorEnabled" INTEGER NOT NULL DEFAULT false,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`),
	);
	await client.run(
		sql.raw(`
		CREATE TABLE IF NOT EXISTS api_keys (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			key_hash TEXT NOT NULL,
			key_prefix TEXT NOT NULL,
			scope TEXT NOT NULL DEFAULT 'read_only',
			created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			expires_at INTEGER,
			last_used_at INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`),
	);
});

beforeEach(async () => {
	await client.delete(apiKeys);
	await client.delete(users);
});

describe("apiKeysService", () => {
	test("create → authenticate round-trip and read-only scope enforcement data", async () => {
		await seedUser("owner-1");
		const created = await apiKeysService.create({ name: "CI", scope: "read_only", creatorUserId: "owner-1" });

		expect(created.key.startsWith("rv_")).toBe(true);
		expect(created.keyPrefix).toBe(created.key.slice(0, 12));

		const principal = await apiKeysService.authenticate(created.key);
		expect(principal?.scope).toBe("read_only");
		expect(principal?.user.id).toBe("owner-1");

		// The stored row never contains the raw secret.
		const rows = await client.select({ keyHash: apiKeys.keyHash }).from(apiKeys);
		expect(rows[0]?.keyHash).not.toContain(created.key);
	});

	test("unknown and revoked keys fail authentication", async () => {
		await seedUser("owner-2");
		const created = await apiKeysService.create({ name: "temp", scope: "full", creatorUserId: "owner-2" });

		expect(await apiKeysService.authenticate("rv_not-a-real-key-value")).toBeUndefined();

		await apiKeysService.revoke(created.id);
		expect(await apiKeysService.authenticate(created.key)).toBeUndefined();

		let revokedError: { code?: string } | undefined;
		try {
			await apiKeysService.revoke(created.id);
		} catch (error) {
			revokedError = error as { code?: string };
		}
		expect(revokedError?.code).toBe("api_key.not_found");
	});

	test("expired keys fail authentication", async () => {
		await seedUser("owner-3");
		const created = await apiKeysService.create({ name: "stale", scope: "full", expiresAtDays: 1, creatorUserId: "owner-3" });

		await client
			.update(apiKeys)
			.set({ expiresAt: new Date(Date.now() - 86_400_000) })
			.where(sql`${apiKeys.id} = ${created.id}`);

		expect(await apiKeysService.authenticate(created.key)).toBeUndefined();
	});
});
