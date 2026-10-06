import type { ProviderEntityType } from "@reelvault/sdk/common";
import { and, eq, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import type { schema } from "@/database/schema";
import { defineRepository, defineTableAccess, mapChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { createProviderStableKey } from "@/database/utils/stable-key";

const providers = defineTableAccess("providers", {
	primaryKeyColumn: "id",
});

const overrides = {
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
				.insert(providers.table)
				.values(chunkValues)
				.onConflictDoUpdate({
					target: providers.table.stableKey,
					set: {
						name: sql`excluded.name`,
						entityType: sql`excluded.entity_type`,
						externalId: sql`excluded.external_id`,
						updatedAt: new Date(),
					},
				})
				.returning(),
		);
	},

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

		return await getProvidersRepository().findOrCreate({
			where: and(eq(providers.table.name, name), eq(providers.table.entityType, entityType), eq(providers.table.externalId, externalId)),
			values: {
				stableKey,
				name,
				entityType,
				externalId,
			},
			tx,
		});
	},
};

export const providersRepository = defineRepository(providers, overrides);

/** Methods dispatch through the singleton so tests can monkey-patch delegations. */
function getProvidersRepository() {
	return providersRepository;
}
