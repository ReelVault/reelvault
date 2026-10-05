import type { GenreFilters, GenreSorting } from "@reelvault/sdk/common";
import type { ProviderResultGenre } from "@reelvault/sdk/plugin";
import { schema } from "@/database/schema";
import { defineTableAccess } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFiltering } from "@/database/utils/filtering";
import { defineNamedEntityRepository } from "@/database/utils/named-entity-repository";
import type { QueryMap } from "@/database/utils/query-parser";
import { metadataRepository } from "./metadata.repository";

const genres = defineTableAccess("genres", { primaryKeyColumn: "id" });
const genreProviders = defineTableAccess("genreProviders", { primaryKeyColumn: "genreId" });

const genreQueryMap: QueryMap<GenreFilters, GenreSorting> = {
	filters: { name: (value: string) => QueryFiltering.like(schema.genres.name, value) },
	orderBy: { name: schema.genres.name, createdAt: schema.genres.createdAt, updatedAt: schema.genres.updatedAt },
	defaults: { sortBy: "name", sortOrder: "asc" },
};

const repository = defineNamedEntityRepository({
	table: schema.genres,
	entity: genres,
	providerEntity: genreProviders,
	nameColumn: schema.genres.name,
	namespace: "genre",
	entityType: "genre",
	entityLabel: "genres",
	queryMap: genreQueryMap,
	insertProviderLinks: async (links, tx) => {
		await genreProviders.insert({ values: links.map(({ entityId, providerId }) => ({ genreId: entityId, providerId })), tx });
	},
	insertMetadataLinks: async ({ metadataId, entityIds, tx }) => {
		await metadataRepository.insertGenres({ values: entityIds.map((genreId) => ({ metadataId, genreId })), tx });
	},
});

/**
 * Process genres for metadata (bulk operation)
 */
async function process({
	metadataId,
	providerName,
	providerGenres,
	tx,
}: {
	metadataId: string;
	providerName: string;
	providerGenres?: ProviderResultGenre[] | undefined;
	tx?: DatabaseTransaction | undefined;
}) {
	await repository.process({ metadataId, providerName, items: providerGenres, tx });
}

export const genreRepository = { ...repository, process };
