import { getTableColumns } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { pickColumnsCached } from "@/integrations/drizzle-orm/query/table-access/field-projection.utils";
import { dateKeysOf } from "@/integrations/drizzle-orm/utils/relation-json.utils";

export const collectionColumns = getTableColumns(schema.collections);

export const companyColumns = getTableColumns(schema.companies);

export const genreColumns = getTableColumns(schema.genres);

export const keywordColumns = getTableColumns(schema.keywords);

export const personColumns = getTableColumns(schema.people);

export const imageColumns = getTableColumns(schema.images);

export const providerColumns = getTableColumns(schema.providers);

export const castColumns = {
	role: schema.metadataCast.role,
	character: schema.metadataCast.character,
	sortOrder: schema.metadataCast.sortOrder,
};

export const crewColumns = { job: schema.metadataCrew.job, department: schema.metadataCrew.department };

export const ratingColumns = getTableColumns(schema.metadataRatings);

export const collectionDateKeys = dateKeysOf(collectionColumns);

export const companyDateKeys = dateKeysOf(companyColumns);

export const genreDateKeys = dateKeysOf(genreColumns);

export const keywordDateKeys = dateKeysOf(keywordColumns);

export const providerDateKeys = dateKeysOf(providerColumns);

export const personDateKeys = dateKeysOf(personColumns);

export const imageDateKeys = dateKeysOf(imageColumns);

export const ratingDateKeys = dateKeysOf(ratingColumns);

export const castDateKeys = dateKeysOf(castColumns);

export const crewDateKeys = dateKeysOf(crewColumns);

export const collectionKeys = Object.keys(collectionColumns);

export const companyKeys = Object.keys(companyColumns);

export const genreKeys = Object.keys(genreColumns);

export const keywordKeys = Object.keys(keywordColumns);

export const providerKeys = Object.keys(providerColumns);

export const personKeys = Object.keys(personColumns);

export const imageKeys = Object.keys(imageColumns);

export const ratingKeys = Object.keys(ratingColumns);

export const castKeys = Object.keys(castColumns);

export const crewKeys = Object.keys(crewColumns);

export const imagePayloadKeys = ["imageType", "data"];

export function selectColumns<T extends Record<string, SQLiteColumn>>(
	requested: Set<string> | undefined,
	columns: T,
	required?: readonly string[],
): Partial<T>;

export function selectColumns(
	requested: Set<string> | undefined,
	columns: Record<string, SQLiteColumn>,
	required: readonly string[] = [],
): Record<string, unknown> {
	if (!requested) return columns;

	return pickColumnsCached(columns, requested, required);
}
