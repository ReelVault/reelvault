import type { CompanyFilters, CompanySorting, Metadata } from "@reelvault/sdk/common";
import { desc, eq } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { defineNamedEntityRepository } from "@/integrations/drizzle-orm/query/named-entity-repository.factory";
import { QueryFiltering } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import type { QueryMap } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
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

export const companiesRepository = { ...repository, findMetadata };
