import { eq, getTableColumns, inArray, type SQL, type SQLChunk, sql } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import { metadataImageOn } from "@/integrations/drizzle-orm/utils/join-conditions.utils";
import { aliasedColumns, orderedJsonArray, relationJsonArray } from "@/integrations/drizzle-orm/utils/relation-json.utils";
import { castColumns, crewColumns, imageColumns, personColumns, ratingColumns } from "./columns.constants";
import { NAMED_RELATIONS, type NamedRelationDefinition } from "./named-relations.constants";
import type { RelationClient } from "./relations.types";

/**
 * Default-projection relation reads (no `fields`) are fixed SQL: the id list travels as one JSON
 * parameter through `json_each`, so each statement is prepared once per connection instead of
 * being rebuilt and re-compiled for every page. One statement per page shape (detail, list)
 * returns every relation as a JSON array built by correlated subqueries that ride the junction
 * indexes — the per-relation round trips are gone.
 */
export const idListSubquery = sql`(SELECT value FROM json_each(${sql.placeholder("ids")}))`;

function namedRelationJson(params: NamedRelationDefinition): SQL<string> {
	const { selectList, pairs } = aliasedColumns(params.columns, "");
	const from = sql`${params.junctionTable} JOIN ${params.entityTable} ON ${params.entityTable.id} = ${params.entityColumn} WHERE ${params.metadataId} = ${schema.metadata.id}`;

	return orderedJsonArray(selectList, pairs, from, sql`${params.entityTable.id}`);
}

function castJson(): SQL<string> {
	const cast = aliasedColumns(castColumns, "");
	const person = aliasedColumns(personColumns, "data_");
	const pairs: SQLChunk[] = [...cast.pairs, sql`'data'`, sql`json_object(${sql.join(person.pairs, sql`, `)})`];
	const from = sql`${schema.metadataCast} JOIN ${schema.people} ON ${schema.people.id} = ${schema.metadataCast.personId} WHERE ${schema.metadataCast.metadataId} = ${schema.metadata.id}`;

	return orderedJsonArray(sql`${cast.selectList}, ${person.selectList}`, pairs, from, schema.metadataCast.personId);
}

function crewJson(): SQL<string> {
	const crew = aliasedColumns(crewColumns, "");
	const person = aliasedColumns(personColumns, "data_");
	const pairs: SQLChunk[] = [...crew.pairs, sql`'data'`, sql`json_object(${sql.join(person.pairs, sql`, `)})`];
	const from = sql`${schema.metadataCrew} JOIN ${schema.people} ON ${schema.people.id} = ${schema.metadataCrew.personId} WHERE ${schema.metadataCrew.metadataId} = ${schema.metadata.id}`;

	return orderedJsonArray(sql`${crew.selectList}, ${person.selectList}`, pairs, from, schema.metadataCrew.personId);
}

function imagesJson(): SQL<string> {
	const image = aliasedColumns(imageColumns, "data_");
	const pairs: SQLChunk[] = [
		sql`'imageType'`,
		sql.identifier("imageType"),
		sql`'data'`,
		sql`json_object(${sql.join(image.pairs, sql`, `)})`,
	];
	const selectList = sql`${schema.metadataImages.imageType} AS ${sql.identifier("imageType")}, ${image.selectList}`;
	const from = sql`${schema.metadataImages} JOIN ${schema.images} ON ${metadataImageOn} WHERE ${schema.metadataImages.metadataId} = ${schema.metadata.id}`;

	return orderedJsonArray(selectList, pairs, from, sql`${schema.metadataImages.imageType}, ${schema.metadataImages.imageId}`);
}

function ratingJson(): SQL<string> {
	const { selectList, pairs } = aliasedColumns(ratingColumns, "");
	const from = sql`${schema.metadataRatings} WHERE ${schema.metadataRatings.metadataId} = ${schema.metadata.id}`;

	return orderedJsonArray(selectList, pairs, from, schema.metadataRatings.source);
}

function lockedFieldsJson(): SQL<string> {
	const selectList = sql`${schema.metadataLockedFields.field} AS ${sql.identifier("field")}`;
	const from = sql`${schema.metadataLockedFields} WHERE ${schema.metadataLockedFields.metadataId} = ${schema.metadata.id}`;

	return relationJsonArray(
		sql`SELECT json_group_array(field) FROM (SELECT ${selectList} FROM ${from} ORDER BY ${schema.metadataLockedFields.field})`,
	);
}

const detailRelationJson = {
	collections: namedRelationJson(NAMED_RELATIONS.collections),
	companies: namedRelationJson(NAMED_RELATIONS.companies),
	genres: namedRelationJson(NAMED_RELATIONS.genres),
	keywords: namedRelationJson(NAMED_RELATIONS.keywords),
	cast: castJson(),
	crew: crewJson(),
	images: imagesJson(),
	rating: ratingJson(),
	providers: namedRelationJson(NAMED_RELATIONS.providers),
	lockedFields: lockedFieldsJson(),
};

export const preparedDetailRelations = createPreparedQuery((client: RelationClient) =>
	client
		.select({ metadataId: schema.metadata.id, ...detailRelationJson })
		.from(schema.metadata)
		.where(inArray(schema.metadata.id, idListSubquery))
		.prepare(),
);

/**
 * Single-id detail read: the root row and every relation come back from one
 * statement — the row the caller already needs anchors the correlated
 * subqueries, so the separate `SELECT * FROM metadata` round trip is gone.
 */
export const preparedDetailRow = createPreparedQuery((client: RelationClient) =>
	client
		.select({ metadata: getTableColumns(schema.metadata), ...detailRelationJson })
		.from(schema.metadata)
		.where(eq(schema.metadata.id, sql.placeholder("id")))
		.prepare(),
);
