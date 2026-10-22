import { and, eq, gt, isNull, or } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { apiKeys } from "@/integrations/drizzle-orm/schemas/api-keys.schema";
import { users } from "@/integrations/drizzle-orm/schemas/auth.schema";

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiKeyInsert = typeof apiKeys.$inferInsert;
export type ApiKeyChanges = Partial<ApiKeyInsert>;

/** The key's owner, joined in one query on the authentication hot path. */
export interface ApiKeyOwnerRow {
	id: string;
	scope: string;
	expiresAt: Date | null;
	userId: string;
	userName: string;
	userEmail: string;
	userRole: string;
}

export const apiKeysRepository = {
	async findAllWithCreator(): Promise<Array<{ key: ApiKeyRow; createdByName: string | null }>> {
		return await databaseFactory
			.getClient()
			.select({ key: apiKeys, createdByName: users.name })
			.from(apiKeys)
			.leftJoin(users, eq(users.id, apiKeys.createdBy))
			.orderBy(apiKeys.createdAt);
	},

	async findById(id: string): Promise<ApiKeyRow | undefined> {
		const [row] = await databaseFactory.getClient().select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);

		return row;
	},

	async findCreatorName(userId: string): Promise<string | null> {
		const [creator] = await databaseFactory.getClient().select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);

		return creator?.name ?? null;
	},

	async insert(row: ApiKeyInsert): Promise<void> {
		await databaseFactory.getClient().insert(apiKeys).values(row);
	},

	async update(id: string, changes: ApiKeyChanges): Promise<void> {
		await databaseFactory.getClient().update(apiKeys).set(changes).where(eq(apiKeys.id, id));
	},

	/** Swaps the stored hash in one statement, so the old secret stops matching as the new one is stored. */
	async replaceSecret(id: string, keyHash: string, keyPrefix: string, now: Date): Promise<void> {
		await databaseFactory
			.getClient()
			.update(apiKeys)
			.set({ keyHash, keyPrefix, lastUsedAt: null, updatedAt: now })
			.where(eq(apiKeys.id, id));
	},

	/** Returns how many rows were deleted. */
	async remove(id: string): Promise<number> {
		const result = await databaseFactory.getClient().delete(apiKeys).where(eq(apiKeys.id, id));

		return result.changes;
	},

	async findActiveOwnerByHash(keyHash: string, now: Date): Promise<ApiKeyOwnerRow | undefined> {
		const [row] = await databaseFactory
			.getClient()
			.select({
				id: apiKeys.id,
				scope: apiKeys.scope,
				expiresAt: apiKeys.expiresAt,
				userId: users.id,
				userName: users.name,
				userEmail: users.email,
				userRole: users.role,
			})
			.from(apiKeys)
			.innerJoin(users, eq(users.id, apiKeys.createdBy))
			.where(and(eq(apiKeys.keyHash, keyHash), or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now))))
			.limit(1);

		return row;
	},

	async touchLastUsed(id: string, at: Date): Promise<void> {
		await databaseFactory.getClient().update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, id));
	},
};
