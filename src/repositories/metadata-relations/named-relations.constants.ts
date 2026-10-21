import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { collectionColumns, companyColumns, genreColumns, keywordColumns, providerColumns } from "./columns.constants";

/** One plain metadata↔entity junction: the four bindings plus the entity columns to project. */
export interface NamedRelationDefinition {
	metadataId: SQLiteColumn;
	junctionTable: SQLiteTable;
	entityColumn: SQLiteColumn;
	entityTable: SQLiteTable & { id: SQLiteColumn };
	columns: Record<string, SQLiteColumn>;
}

/**
 * The five plain junction relations, declared once. JSON detail reads, explicit
 * field projections and the batched list readers all iterate this record, so a
 * new relation is wired in one place instead of three.
 */
export const NAMED_RELATIONS = {
	collections: {
		metadataId: schema.metadataCollections.metadataId,
		junctionTable: schema.metadataCollections,
		entityColumn: schema.metadataCollections.collectionId,
		entityTable: schema.collections,
		columns: collectionColumns,
	},
	companies: {
		metadataId: schema.metadataCompanies.metadataId,
		junctionTable: schema.metadataCompanies,
		entityColumn: schema.metadataCompanies.companyId,
		entityTable: schema.companies,
		columns: companyColumns,
	},
	genres: {
		metadataId: schema.metadataGenres.metadataId,
		junctionTable: schema.metadataGenres,
		entityColumn: schema.metadataGenres.genreId,
		entityTable: schema.genres,
		columns: genreColumns,
	},
	keywords: {
		metadataId: schema.metadataKeywords.metadataId,
		junctionTable: schema.metadataKeywords,
		entityColumn: schema.metadataKeywords.keywordId,
		entityTable: schema.keywords,
		columns: keywordColumns,
	},
	providers: {
		metadataId: schema.metadataProviders.metadataId,
		junctionTable: schema.metadataProviders,
		entityColumn: schema.metadataProviders.providerId,
		entityTable: schema.providers,
		columns: providerColumns,
	},
} as const satisfies Record<string, NamedRelationDefinition>;

export type NamedRelationName = keyof typeof NAMED_RELATIONS;
