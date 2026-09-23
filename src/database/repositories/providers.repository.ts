import type { ProviderEntityType } from "@reelvault/sdk/common";
import { and, eq, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { defineTableAccess, mapChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { createProviderStableKey } from "@/database/utils/stable-key";

const providers = defineTableAccess("providers", {
	primaryKeyColumn: "id",
});

class ProvidersRepository {
	readonly table = schema.providers;
	readonly primaryKeyColumn = providers.primaryKeyColumn;
	readonly query = providers.query;
	readonly selectMany = providers.selectMany;
	readonly selectFirst = providers.selectFirst;
	readonly findOrCreate = providers.findOrCreate;
	readonly insert = providers.insert;
	readonly update = providers.update;
	readonly count = providers.count;
	readonly isExists = providers.isExists;
	readonly delete = providers.delete;
	readonly insertReturning = providers.insertReturning;
	readonly updateReturning = providers.updateReturning;
	readonly updateAndReturn = providers.updateAndReturn;
	readonly deleteReturning = providers.deleteReturning;
	readonly deleteAndReturn = providers.deleteAndReturn;
	readonly findByIds = providers.findByIds;
	readonly findByColumnIn = providers.findByColumnIn;

	async upsertByStableKey(
		values: Array<{ stableKey: string; name: string; entityType: ProviderEntityType; externalId: string }>,
		tx?: DatabaseTransaction,
	): Promise<Array<typeof schema.providers.$inferSelect>> {
		if (values.length === 0) return [];

		// Chunk the multi-row upsert — an unbounded cast/crew list can exceed
		// SQLite's bound-variable limit and holds the write lock longer.
		return await mapChunked(values, (chunkValues) =>
			databaseFactory
				.getClient({ tx })
				.insert(this.table)
				.values(chunkValues)
				.onConflictDoUpdate({
					target: this.table.stableKey,
					set: {
						name: sql`excluded.name`,
						entityType: sql`excluded.entity_type`,
						externalId: sql`excluded.external_id`,
						updatedAt: new Date(),
					},
				})
				.returning(),
		);
	}

	/**
	 * Find or create provider entry by provider name, entity type, and external ID
	 */
	async findOrCreateByIdentity({
		name,
		entityType,
		externalId,
		tx,
	}: {
		name: string;
		entityType: ProviderEntityType;
		externalId: string;
		tx?: DatabaseTransaction | undefined;
	}) {
		const stableKey = createProviderStableKey({ providerName: name, entityType, externalId });

		return await this.findOrCreate({
			where: and(eq(this.table.name, name), eq(this.table.entityType, entityType), eq(this.table.externalId, externalId)),
			values: {
				stableKey,
				name,
				entityType,
				externalId,
			},
			tx,
		});
	}
}

export const providersRepository = new ProvidersRepository();
