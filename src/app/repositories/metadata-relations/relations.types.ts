import type { MetadataWithRelation } from "@reelvault/sdk/common";
import type { SelectedFieldsFlat, SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { databaseFactory } from "@/integrations/drizzle-orm/database.factory";

export type MetadataRelationData = Pick<
	MetadataWithRelation,
	"collections" | "companies" | "genres" | "keywords" | "cast" | "crew" | "images" | "rating" | "providers" | "lockedFields"
>;

/**
 * Loads a plain metadata↔entity junction (collections/companies/genres/keywords/
 * providers): the entity columns (optionally projected) keyed by metadata id.
 */
export interface NamedRelationParams<TSelection extends SelectedFieldsFlat, TMetadataId extends SQLiteColumn> {
	metadataId: TMetadataId;
	junctionTable: SQLiteTable;
	entityColumn: SQLiteColumn;
	entityTable: SQLiteTable & { id: SQLiteColumn };
	data: TSelection;
}

/** Plain metadata↔entity junction as a JSON array, riding the junction's (metadata_id, entity) index. */
export interface JsonRelationParams {
	metadataId: SQLiteColumn;
	junctionTable: SQLiteTable;
	entityColumn: SQLiteColumn;
	entityTable: SQLiteTable & { id: SQLiteColumn };
	data: Record<string, SQLiteColumn>;
}

export type RelationItem<K extends keyof MetadataRelationData> = MetadataRelationData[K] extends ReadonlyArray<infer T> ? T : never;

export interface DetailRelationsRow {
	metadataId: string;
	collections: string;
	companies: string;
	genres: string;
	keywords: string;
	cast: string;
	crew: string;
	images: string;
	rating: string;
	providers: string;
	lockedFields: string;
}

export type RelationClient = ReturnType<typeof databaseFactory.getClient>;
