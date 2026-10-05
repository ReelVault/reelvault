import type { KeywordFilters, KeywordSorting } from "@reelvault/sdk/common";
import type { ProviderResultKeyword } from "@reelvault/sdk/plugin";
import { schema } from "@/database/schema";
import { defineTableAccess } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFiltering } from "@/database/utils/filtering";
import { defineNamedEntityRepository } from "@/database/utils/named-entity-repository";
import type { QueryMap } from "@/database/utils/query-parser";
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
	nameColumn: schema.keywords.name,
	namespace: "keyword",
	entityType: "keyword",
	entityLabel: "keywords",
	queryMap: keywordQueryMap,
	insertProviderLinks: async (links, tx) => {
		await keywordProviders.insert({ values: links.map(({ entityId, providerId }) => ({ keywordId: entityId, providerId })), tx });
	},
	insertMetadataLinks: async ({ metadataId, entityIds, tx }) => {
		await metadataRepository.insertKeywords({ values: entityIds.map((keywordId) => ({ metadataId, keywordId })), tx });
	},
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
	await repository.process({ metadataId, providerName, items: keywordNames, tx });
}

export const keywordsRepository = { ...repository, process };
