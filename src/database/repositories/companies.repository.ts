import type { CompanyFilters, CompanySorting, Metadata } from "@reelvault/sdk/common";
import type { ProviderResultProductionCompany } from "@reelvault/sdk/plugin";
import { desc, eq } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { defineTableAccess } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFiltering } from "@/database/utils/filtering";
import { defineNamedEntityRepository } from "@/database/utils/named-entity-repository";
import type { QueryMap } from "@/database/utils/query-parser";
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
	nameColumn: schema.companies.name,
	namespace: "company",
	entityType: "company",
	entityLabel: "companies",
	queryMap: companyQueryMap,
	insertProviderLinks: async (links, tx) => {
		await companyProviders.insert({ values: links.map(({ entityId, providerId }) => ({ companyId: entityId, providerId })), tx });
	},
	insertMetadataLinks: async ({ metadataId, entityIds, tx }) => {
		await metadataRepository.insertCompanies({ values: entityIds.map((companyId) => ({ metadataId, companyId })), tx });
	},
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
	await repository.process({ metadataId, providerName, items: providerCompanies, tx });
}

export const companiesRepository = { ...repository, findMetadata, process };
