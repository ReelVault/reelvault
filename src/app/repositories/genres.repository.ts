import type { GenreFilters, GenreSorting } from "@reelvault/sdk/common";
import type { ProviderResultGenre } from "@reelvault/sdk/plugin";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { defineNamedEntityRepository } from "@/integrations/drizzle-orm/query/named-entity-repository.factory";
import { QueryFiltering } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import type { QueryMap } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
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
