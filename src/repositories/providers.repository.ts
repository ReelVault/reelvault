import type { ProviderEntityType } from "@reelvault/sdk/common";
import { and, eq, sql } from "drizzle-orm";
import type { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { defineRepository, defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { createProviderStableKey } from "@/integrations/drizzle-orm/utils/stable-key.utils";

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
			providers.upsert({
				values: chunkValues,
				target: providers.table.stableKey,
				set: {
					name: sql`excluded.name`,
					entityType: sql`excluded.entity_type`,
					externalId: sql`excluded.external_id`,
					updatedAt: new Date(),
				},
				returning: true,
				tx,
			}),
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

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getProvidersRepository() {
	return providersRepository;
}
