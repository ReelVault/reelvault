import type { Genre, GenreFilters, GenreSorting } from "@sdk/common/genre.types";
import type { ProviderResultGenre } from "@sdk/plugin";
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
	queryMap: genreQueryMap,
	findOrCreateByName: ({ name, values, tx }): Promise<Genre | undefined> =>
		genres.findOrCreate({
			where: eq(schema.genres.name, name),
			values: { ...values, stableKey: createLocalStableKey({ namespace: "genre", value: name }) },
			tx,
		}),
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
	await processNamedEntities({
		items: providerGenres,
		providerName,
		entityType: "genre",
		entityLabel: "genres",
		tx,
		insertEntities: async (items) => await upsertNamedEntities(repository.table, items, tx),
		selectEntities: async (names) => await repository.selectMany({ where: inArray(repository.table.name, names), tx }),
		persistAssociations: async (associations) => {
			const uniqueEntityIds = unique(associations, ({ entityId }) => entityId);
			await Promise.all([
				repository.insertProviders({
					values: associations.flatMap(({ entityId, providerId }) => (providerId ? [{ genreId: entityId, providerId }] : [])),
					tx,
				}),
				metadataRepository.insertGenres({
					values: uniqueEntityIds.map((entityId) => ({ metadataId, genreId: entityId })),
					tx,
				}),
			]);
		},
	});
}

export const genreRepository = { ...repository, process };
