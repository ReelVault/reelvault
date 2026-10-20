import type { MetadataWithRelation } from "@reelvault/sdk/common";
import type { databaseFactory } from "@/integrations/drizzle-orm/database.factory";

export type MetadataRelationData = Pick<
	MetadataWithRelation,
	"collections" | "companies" | "genres" | "keywords" | "cast" | "crew" | "images" | "rating" | "providers" | "lockedFields"
>;

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
