import type { Keyword, KeywordFilters, KeywordSorting } from "@reelvault/sdk/common";
import type { ProviderResultKeyword } from "@reelvault/sdk/plugin";
import { eq, inArray } from "drizzle-orm";
import { schema } from "@/database/schema";
import { defineTableAccess } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFiltering } from "@/database/utils/filtering";
import { defineNamedEntityRepository } from "@/database/utils/named-entity-repository";
import type { QueryMap } from "@/database/utils/query-parser";
import { createLocalStableKey } from "@/database/utils/stable-key";
import { unique } from "@/utils/array.utils";
import { processNamedEntities, upsertNamedEntities } from "../utils/provider-entity-sync";
import { metadataRepository } from "./metadata.repository";

const keywords = defineTableAccess("keywords", { primaryKeyColumn: "id" });
const keywordProviders = defineTableAccess("keywordProviders", { primaryKeyColumn: "keywordId" });

const keywordQueryMap: QueryMap<KeywordFilters, KeywordSorting> = {
	filters: { name: (value: string) => QueryFiltering.like(schema.keywords.name, value) },
	orderBy: { name: schema.keywords.name, createdAt: schema.keywords.createdAt, updatedAt: schema.keywords.updatedAt },
	defaults: { sortBy: "name", sortOrder: "asc" },
};

const repository = defineNamedEntityRepository({
	table: schema.keywords,
	entity: keywords,
	providerEntity: keywordProviders,
	queryMap: keywordQueryMap,
	findOrCreateByName: ({ name, values, tx }): Promise<Keyword | undefined> =>
		keywords.findOrCreate({
			where: eq(schema.keywords.name, name),
			values: { ...values, stableKey: createLocalStableKey({ namespace: "keyword", value: name }) },
			tx,
		}),
});

/**
 * Process keywords for metadata (bulk operation)
 */
async function process({
	metadataId,
	providerName,
	keywordNames,
	tx,
}: {
	metadataId: string;
	providerName: string;
	keywordNames?: ProviderResultKeyword[] | undefined;
	tx?: DatabaseTransaction | undefined;
}) {
	await processNamedEntities({
		items: keywordNames,
		providerName,
		entityType: "keyword",
		entityLabel: "keywords",
		tx,
		insertEntities: async (items) => await upsertNamedEntities(repository.table, items, tx),
		selectEntities: async (names) => await repository.selectMany({ where: inArray(repository.table.name, names), tx }),
		persistAssociations: async (associations) => {
			const uniqueEntityIds = unique(associations, ({ entityId }) => entityId);
			await Promise.all([
				repository.insertProviders({
					values: associations.flatMap(({ entityId, providerId }) => (providerId ? [{ keywordId: entityId, providerId }] : [])),
					tx,
				}),
				metadataRepository.insertKeywords({
					values: uniqueEntityIds.map((entityId) => ({ metadataId, keywordId: entityId })),
					tx,
				}),
			]);
		},
	});
}

export const keywordsRepository = { ...repository, process };
