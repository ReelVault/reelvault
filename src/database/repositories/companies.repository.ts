import type { Company, CompanyFilters, CompanySorting } from "@sdk/common/companies.types";
import type { Metadata } from "@sdk/common/metadata.types";
import type { ProviderResultProductionCompany } from "@sdk/plugin";
import { desc, eq, inArray } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
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

const companies = defineTableAccess("companies", { primaryKeyColumn: "id" });
const companyProviders = defineTableAccess("companyProviders", { primaryKeyColumn: "companyId" });

const companyQueryMap: QueryMap<CompanyFilters, CompanySorting> = {
	filters: { name: (value: string) => QueryFiltering.like(schema.companies.name, value) },
	orderBy: { name: schema.companies.name, createdAt: schema.companies.createdAt, updatedAt: schema.companies.updatedAt },
	defaults: { sortBy: "name", sortOrder: "asc" },
};

const repository = defineNamedEntityRepository({
	table: schema.companies,
	entity: companies,
	providerEntity: companyProviders,
	queryMap: companyQueryMap,
	findOrCreateByName: ({ name, values, tx }): Promise<Company | undefined> =>
		companies.findOrCreate({
			where: eq(schema.companies.name, name),
			values: { ...values, stableKey: createLocalStableKey({ namespace: "company", value: name }) },
			tx,
		}),
});

/** Metadata rows associated with a company, most popular first. */
async function findMetadata({ companyId, limit }: { companyId: string; limit: number }): Promise<Metadata[]> {
	const rows = await databaseFactory
		.getClient()
		.select({ metadata: schema.metadata })
		.from(schema.metadataCompanies)
		.innerJoin(schema.metadata, eq(schema.metadata.id, schema.metadataCompanies.metadataId))
		.where(eq(schema.metadataCompanies.companyId, companyId))
		.orderBy(desc(schema.metadata.popularity), desc(schema.metadata.createdAt))
		.limit(limit);

	return rows.map((row) => row.metadata);
}

/**
 * Process companies for metadata (bulk operation)
 */
async function process({
	metadataId,
	providerName,
	providerCompanies,
	tx,
}: {
	metadataId: string;
	providerName: string;
	providerCompanies?: ProviderResultProductionCompany[] | undefined;
	tx?: DatabaseTransaction | undefined;
}) {
	await processNamedEntities({
		items: providerCompanies,
		providerName,
		entityType: "company",
		entityLabel: "companies",
		tx,
		insertEntities: async (items) => await upsertNamedEntities(repository.table, items, tx),
		selectEntities: async (names) => await repository.selectMany({ where: inArray(repository.table.name, names), tx }),
		persistAssociations: async (associations) => {
			const uniqueEntityIds = unique(associations, ({ entityId }) => entityId);
			await Promise.all([
				repository.insertProviders({
					values: associations.flatMap(({ entityId, providerId }) => (providerId ? [{ companyId: entityId, providerId }] : [])),
					tx,
				}),
				metadataRepository.insertCompanies({
					values: uniqueEntityIds.map((entityId) => ({ metadataId, companyId: entityId })),
					tx,
				}),
			]);
		},
	});
}

export const companiesRepository = { ...repository, findMetadata, process };
