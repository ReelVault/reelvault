import type { FieldsConfig, MetadataWithRelation } from "@reelvault/sdk/common";
import { eq, getTableColumns, inArray, type SQL, type SQLChunk, sql } from "drizzle-orm";
import type { SelectedFieldsFlat, SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { systemSettingsStore } from "@/config/system-settings.store";
import { databaseFactory } from "@/database/database";
import { createPreparedQuery } from "@/database/prepared-queries";
import { schema } from "@/database/schema";
import { pickColumns } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { metadataImageOn } from "@/database/utils/join-conditions";
import { serverConstants } from "@/server.constants";
import { chunk } from "@/utils/array.utils";
import { safeParseJson } from "@/utils/file.utils";
import { calculateAverageScore } from "./metadata-recommendations";

export type MetadataRelationData = Pick<
	MetadataWithRelation,
	"collections" | "companies" | "genres" | "keywords" | "cast" | "crew" | "images" | "rating" | "providers" | "lockedFields"
>;

const collectionColumns = getTableColumns(schema.collections);
const companyColumns = getTableColumns(schema.companies);
const genreColumns = getTableColumns(schema.genres);
const keywordColumns = getTableColumns(schema.keywords);
const personColumns = getTableColumns(schema.people);
const imageColumns = getTableColumns(schema.images);
const providerColumns = getTableColumns(schema.providers);
const castColumns = {
	role: schema.metadataCast.role,
	character: schema.metadataCast.character,
	sortOrder: schema.metadataCast.sortOrder,
};
const crewColumns = { job: schema.metadataCrew.job, department: schema.metadataCrew.department };
const ratingColumns = getTableColumns(schema.metadataRatings);

/**
 * Loads a plain metadata↔entity junction (collections/companies/genres/keywords/
 * providers): the entity columns (optionally projected) keyed by metadata id.
 */
interface NamedRelationParams<TSelection extends SelectedFieldsFlat, TMetadataId extends SQLiteColumn> {
	metadataId: TMetadataId;
	junctionTable: SQLiteTable;
	entityColumn: SQLiteColumn;
	entityTable: SQLiteTable & { id: SQLiteColumn };
	data: TSelection;
}

function loadNamedRelation<TSelection extends SelectedFieldsFlat, TMetadataId extends SQLiteColumn>(
	client: DatabaseTransaction,
	metadataIds: string[] | SQL,
	params: NamedRelationParams<TSelection, TMetadataId>,
) {
	return client
		.select({ metadataId: params.metadataId, data: params.data })
		.from(params.junctionTable)
		.innerJoin(params.entityTable, eq(params.entityTable.id, params.entityColumn))
		.where(inArray(params.metadataId, metadataIds));
}

/**
 * Default-projection relation reads (no `fields`) are fixed SQL: the id list travels as one JSON
 * parameter through `json_each`, so each statement is prepared once per connection instead of
 * being rebuilt and re-compiled for every page. One statement per page shape (detail, list)
 * returns every relation as a JSON array built by correlated subqueries that ride the junction
 * indexes — the per-relation round trips are gone.
 */
const idListSubquery = sql`(SELECT value FROM json_each(${sql.placeholder("ids")}))`;

/** One relation as a JSON array — `[]` when the title has no rows for it. */
function relationJsonArray(rows: SQL): SQL<string> {
	return sql<string>`coalesce((${rows}), '[]')`;
}

/** Inner SELECT aliases every column to its DTO key so the outer json_object can read it. */
function aliasedColumns(columns: Record<string, SQLiteColumn>, prefix: string): { selectList: SQL; pairs: SQLChunk[] } {
	const selectParts: SQL[] = [];
	const pairs: SQLChunk[] = [];
	for (const [key, column] of Object.entries(columns)) {
		const alias = `${prefix}${key}`;
		selectParts.push(sql`${column} AS ${sql.identifier(alias)}`);
		pairs.push(sql`${key}`, sql.identifier(alias));
	}

	return { selectList: sql.join(selectParts, sql`, `), pairs };
}

/** `json_group_array` over an ordered, aliased subquery — row order matches the junction index. */
function orderedJsonArray(selectList: SQLChunk, pairs: SQLChunk[], from: SQLChunk, orderBy: SQLChunk): SQL<string> {
	return relationJsonArray(
		sql`SELECT json_group_array(json_object(${sql.join(pairs, sql`, `)})) FROM (SELECT ${selectList} FROM ${from} ORDER BY ${orderBy})`,
	);
}

/** Plain metadata↔entity junction as a JSON array, riding the junction's (metadata_id, entity) index. */
interface JsonRelationParams {
	metadataId: SQLiteColumn;
	junctionTable: SQLiteTable;
	entityColumn: SQLiteColumn;
	entityTable: SQLiteTable & { id: SQLiteColumn };
	data: Record<string, SQLiteColumn>;
}

function namedRelationJson(params: JsonRelationParams): SQL<string> {
	const { selectList, pairs } = aliasedColumns(params.data, "");
	const from = sql`${params.junctionTable} JOIN ${params.entityTable} ON ${params.entityTable.id} = ${params.entityColumn} WHERE ${params.metadataId} = ${schema.metadata.id}`;

	return orderedJsonArray(selectList, pairs, from, sql`${params.entityTable.id}`);
}

const collectionRelation: JsonRelationParams = {
	metadataId: schema.metadataCollections.metadataId,
	junctionTable: schema.metadataCollections,
	entityColumn: schema.metadataCollections.collectionId,
	entityTable: schema.collections,
	data: collectionColumns,
};

const companyRelation: JsonRelationParams = {
	metadataId: schema.metadataCompanies.metadataId,
	junctionTable: schema.metadataCompanies,
	entityColumn: schema.metadataCompanies.companyId,
	entityTable: schema.companies,
	data: companyColumns,
};

const genreRelation: JsonRelationParams = {
	metadataId: schema.metadataGenres.metadataId,
	junctionTable: schema.metadataGenres,
	entityColumn: schema.metadataGenres.genreId,
	entityTable: schema.genres,
	data: genreColumns,
};

const keywordRelation: JsonRelationParams = {
	metadataId: schema.metadataKeywords.metadataId,
	junctionTable: schema.metadataKeywords,
	entityColumn: schema.metadataKeywords.keywordId,
	entityTable: schema.keywords,
	data: keywordColumns,
};

const providerRelation: JsonRelationParams = {
	metadataId: schema.metadataProviders.metadataId,
	junctionTable: schema.metadataProviders,
	entityColumn: schema.metadataProviders.providerId,
	entityTable: schema.providers,
	data: providerColumns,
};

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

const preparedDetailRelations = createPreparedQuery((client: RelationClient) =>
	client
		.select({
			metadataId: schema.metadata.id,
			collections: namedRelationJson(collectionRelation),
			companies: namedRelationJson(companyRelation),
			genres: namedRelationJson(genreRelation),
			keywords: namedRelationJson(keywordRelation),
			cast: castJson(),
			crew: crewJson(),
			images: imagesJson(),
			rating: ratingJson(),
			providers: namedRelationJson(providerRelation),
			lockedFields: lockedFieldsJson(),
		})
		.from(schema.metadata)
		.where(inArray(schema.metadata.id, idListSubquery))
		.prepare(),
);

/** Batched list relations: one prepared query per relation is faster for a page of ids than per-row correlated subqueries. */
function preparedBatchedRelation<TSelection extends SelectedFieldsFlat, TMetadataId extends SQLiteColumn>(
	params: NamedRelationParams<TSelection, TMetadataId>,
	orderBy: SQL | SQLiteColumn,
) {
	return createPreparedQuery((client: RelationClient) => loadNamedRelation(client, idListSubquery, params).orderBy(orderBy).prepare());
}

const preparedListGenres = preparedBatchedRelation(
	{
		metadataId: schema.metadataGenres.metadataId,
		junctionTable: schema.metadataGenres,
		entityColumn: schema.metadataGenres.genreId,
		entityTable: schema.genres,
		data: selectColumns(undefined, genreColumns),
	},
	schema.genres.id,
);

const preparedListImages = createPreparedQuery((client: RelationClient) =>
	client
		.select({
			metadataId: schema.metadataImages.metadataId,
			imageType: schema.metadataImages.imageType,
			data: selectColumns(undefined, imageColumns),
		})
		.from(schema.metadataImages)
		.innerJoin(schema.images, metadataImageOn)
		.where(inArray(schema.metadataImages.metadataId, idListSubquery))
		.orderBy(schema.metadataImages.imageType, schema.metadataImages.imageId)
		.prepare(),
);

const preparedListRatings = createPreparedQuery((client: RelationClient) =>
	client
		.select({ metadataId: schema.metadataRatings.metadataId, data: selectColumns(undefined, ratingColumns) })
		.from(schema.metadataRatings)
		.where(inArray(schema.metadataRatings.metadataId, idListSubquery))
		.orderBy(schema.metadataRatings.source)
		.prepare(),
);

/** Fresh empty relation payload — callers mutate the arrays, so never share one instance. */
function emptyRelationData(): MetadataRelationData {
	return {
		collections: [],
		companies: [],
		genres: [],
		keywords: [],
		cast: [],
		crew: [],
		images: [],
		rating: { avgScore: 0, scores: [] },
		providers: [],
		lockedFields: [],
	};
}

type RelationItem<K extends keyof MetadataRelationData> = MetadataRelationData[K] extends ReadonlyArray<infer T> ? T : never;

/** Keys of integer `timestamp` columns, which drizzle maps to Date but JSON returns as seconds. */
function dateKeysOf(columns: Record<string, SQLiteColumn>): string[] {
	return Object.entries(columns)
		.filter(([, column]) => column.dataType === "object date")
		.map(([key]) => key);
}

const collectionDateKeys = dateKeysOf(collectionColumns);
const companyDateKeys = dateKeysOf(companyColumns);
const genreDateKeys = dateKeysOf(genreColumns);
const keywordDateKeys = dateKeysOf(keywordColumns);
const providerDateKeys = dateKeysOf(providerColumns);
const personDateKeys = dateKeysOf(personColumns);
const imageDateKeys = dateKeysOf(imageColumns);
const ratingDateKeys = dateKeysOf(ratingColumns);
const castDateKeys = dateKeysOf(castColumns);
const crewDateKeys = dateKeysOf(crewColumns);

const collectionKeys = Object.keys(collectionColumns);
const companyKeys = Object.keys(companyColumns);
const genreKeys = Object.keys(genreColumns);
const keywordKeys = Object.keys(keywordColumns);
const providerKeys = Object.keys(providerColumns);
const personKeys = Object.keys(personColumns);
const imageKeys = Object.keys(imageColumns);
const ratingKeys = Object.keys(ratingColumns);
const castKeys = Object.keys(castColumns);
const crewKeys = Object.keys(crewColumns);
const imagePayloadKeys = ["imageType", "data"];

/** SQLite JSON returns raw seconds for timestamp columns; drizzle returns Date. */
function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows a JSON payload item to a relation DTO shape. The SQL builder emits
 * exactly the columns in `keys`; `_shape` anchors the type parameter to the
 * caller's DTO type.
 */
function isRelationItem<T extends object>(item: unknown, keys: readonly string[], _shape?: T): item is T {
	if (!isRecordValue(item)) return false;

	return keys.every((key) => key in item);
}

function reviveDateColumns(item: unknown, keys: readonly string[]): void {
	if (keys.length === 0 || !isRecordValue(item)) return;

	for (const key of keys) {
		const value = item[key];
		if (typeof value === "number") item[key] = new Date(value * 1000);
	}
}

/** Relation payloads arrive as JSON strings; the SQL builder fixes the shape. */
function parsePayload<T extends object>(payload: string, keys: readonly string[], dateKeys: readonly string[]): T[] {
	const parsed = safeParseJson(payload);
	if (!Array.isArray(parsed)) return [];

	const items: T[] = [];
	for (const item of parsed) {
		if (!isRelationItem<T>(item, keys)) continue;

		reviveDateColumns(item, dateKeys);
		items.push(item);
	}

	return items;
}

function parseStringPayload(payload: string): string[] {
	const parsed = safeParseJson(payload);

	return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

/** Payload items with a nested `data` object (cast, crew, images) revive both levels. */
function parseNestedPayload<T extends object>(
	payload: string,
	keys: readonly string[],
	dataKeys: readonly string[],
	outerDateKeys: readonly string[],
	dataDateKeys: readonly string[],
): T[] {
	const parsed = safeParseJson(payload);
	if (!Array.isArray(parsed)) return [];

	const items: T[] = [];
	for (const item of parsed) {
		if (!isRelationItem<T>(item, keys)) continue;

		reviveDateColumns(item, outerDateKeys);
		const data = isRecordValue(item) ? item.data : undefined;
		if (isRelationItem(data, dataKeys)) reviveDateColumns(data, dataDateKeys);
		items.push(item);
	}

	return items;
}

interface DetailRelationsRow {
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

function applyDetailRelations(target: MetadataRelationData, row: DetailRelationsRow): void {
	target.collections.push(...parsePayload<RelationItem<"collections">>(row.collections, collectionKeys, collectionDateKeys));
	target.companies.push(...parsePayload<RelationItem<"companies">>(row.companies, companyKeys, companyDateKeys));
	target.genres.push(...parsePayload<RelationItem<"genres">>(row.genres, genreKeys, genreDateKeys));
	target.keywords.push(...parsePayload<RelationItem<"keywords">>(row.keywords, keywordKeys, keywordDateKeys));
	target.cast.push(...parseNestedPayload<RelationItem<"cast">>(row.cast, castKeys, personKeys, castDateKeys, personDateKeys));
	target.crew.push(...parseNestedPayload<RelationItem<"crew">>(row.crew, crewKeys, personKeys, crewDateKeys, personDateKeys));
	target.images.push(...parseNestedPayload<RelationItem<"images">>(row.images, imagePayloadKeys, imageKeys, [], imageDateKeys));
	target.rating.scores.push(...parsePayload<MetadataRelationData["rating"]["scores"][number]>(row.rating, ratingKeys, ratingDateKeys));
	target.providers.push(...parsePayload<RelationItem<"providers">>(row.providers, providerKeys, providerDateKeys));
	target.lockedFields.push(...parseStringPayload(row.lockedFields));
}

type RelationClient = ReturnType<typeof databaseFactory.getClient>;

/** Plain junction relations (metadata↔entity lists) for explicit field projections. */
function loadJunctionRows<F extends string>(
	client: RelationClient,
	metadataIds: string[],
	fields: FieldsConfig<F> | undefined,
	includes: (rel: string) => boolean,
) {
	return Promise.all([
		loadIf(
			includes("collections"),
			async () =>
				await loadNamedRelation(client, metadataIds, {
					metadataId: schema.metadataCollections.metadataId,
					junctionTable: schema.metadataCollections,
					entityColumn: schema.metadataCollections.collectionId,
					entityTable: schema.collections,
					data: selectColumns(relationFields(fields, "collections"), collectionColumns),
				}),
		),
		loadIf(
			includes("companies"),
			async () =>
				await loadNamedRelation(client, metadataIds, {
					metadataId: schema.metadataCompanies.metadataId,
					junctionTable: schema.metadataCompanies,
					entityColumn: schema.metadataCompanies.companyId,
					entityTable: schema.companies,
					data: selectColumns(relationFields(fields, "companies"), companyColumns),
				}),
		),
		loadIf(
			includes("genres"),
			async () =>
				await loadNamedRelation(client, metadataIds, {
					metadataId: schema.metadataGenres.metadataId,
					junctionTable: schema.metadataGenres,
					entityColumn: schema.metadataGenres.genreId,
					entityTable: schema.genres,
					data: selectColumns(relationFields(fields, "genres"), genreColumns),
				}),
		),
		loadIf(
			includes("keywords"),
			async () =>
				await loadNamedRelation(client, metadataIds, {
					metadataId: schema.metadataKeywords.metadataId,
					junctionTable: schema.metadataKeywords,
					entityColumn: schema.metadataKeywords.keywordId,
					entityTable: schema.keywords,
					data: selectColumns(relationFields(fields, "keywords"), keywordColumns),
				}),
		),
		loadIf(
			includes("providers"),
			async () =>
				await loadNamedRelation(client, metadataIds, {
					metadataId: schema.metadataProviders.metadataId,
					junctionTable: schema.metadataProviders,
					entityColumn: schema.metadataProviders.providerId,
					entityTable: schema.providers,
					data: selectColumns(relationFields(fields, "providers"), providerColumns),
				}),
		),
	]);
}

/** Person, media and rating relations for explicit field projections. */
function loadRelationRows<F extends string>(
	client: RelationClient,
	metadataIds: string[],
	fields: FieldsConfig<F> | undefined,
	includes: (rel: string) => boolean,
) {
	return Promise.all([
		loadIf(
			includes("cast"),
			async () =>
				await client
					.select({
						metadataId: schema.metadataCast.metadataId,
						...selectColumns(relationFields(fields, "cast"), castColumns),
						data: selectColumns(nestedRelationFields(relationFields(fields, "cast"), "data"), personColumns),
					})
					.from(schema.metadataCast)
					.innerJoin(schema.people, eq(schema.people.id, schema.metadataCast.personId))
					.where(inArray(schema.metadataCast.metadataId, metadataIds)),
		),
		loadIf(
			includes("crew"),
			async () =>
				await client
					.select({
						metadataId: schema.metadataCrew.metadataId,
						...selectColumns(relationFields(fields, "crew"), crewColumns),
						data: selectColumns(nestedRelationFields(relationFields(fields, "crew"), "data"), personColumns),
					})
					.from(schema.metadataCrew)
					.innerJoin(schema.people, eq(schema.people.id, schema.metadataCrew.personId))
					.where(inArray(schema.metadataCrew.metadataId, metadataIds)),
		),
		loadIf(
			includes("images"),
			async () =>
				await client
					.select({
						metadataId: schema.metadataImages.metadataId,
						imageType: schema.metadataImages.imageType,
						data: selectColumns(nestedRelationFields(relationFields(fields, "images"), "data"), imageColumns),
					})
					.from(schema.metadataImages)
					.innerJoin(schema.images, metadataImageOn)
					.where(inArray(schema.metadataImages.metadataId, metadataIds)),
		),
		loadIf(
			includes("rating"),
			async () =>
				await client
					.select({
						metadataId: schema.metadataRatings.metadataId,
						data: selectColumns(ratingFields(fields), ratingColumns),
					})
					.from(schema.metadataRatings)
					.where(inArray(schema.metadataRatings.metadataId, metadataIds)),
		),
		loadIf(
			includes("lockedFields"),
			async () =>
				await client
					.select({ metadataId: schema.metadataLockedFields.metadataId, field: schema.metadataLockedFields.field })
					.from(schema.metadataLockedFields)
					.where(inArray(schema.metadataLockedFields.metadataId, metadataIds)),
		),
	]);
}

/** Default detail projection: one prepared statement returns every relation as JSON. */
function loadMergedDetailRelations(
	relationsByMetadataId: Map<string, MetadataRelationData>,
	client: RelationClient,
	metadataIds: string[],
): void {
	for (const metadataId of metadataIds) {
		relationsByMetadataId.set(metadataId, emptyRelationData());
	}

	const rows: DetailRelationsRow[] = preparedDetailRelations(client).all({ ids: JSON.stringify(metadataIds) });
	for (const row of rows) {
		const data = relationsByMetadataId.get(row.metadataId);
		if (data) applyDetailRelations(data, row);
	}

	for (const data of relationsByMetadataId.values()) {
		data.cast.sort((a, b) => a.sortOrder - b.sortOrder);
	}
}

/** Default list projection: batched per-relation queries — faster for a page of ids than per-row correlated subqueries. */
function loadBatchedListRelations(
	relationsByMetadataId: Map<string, MetadataRelationData>,
	client: RelationClient,
	metadataIds: string[],
): void {
	const ids = JSON.stringify(metadataIds);
	const genres = preparedListGenres(client).all({ ids });
	const images = preparedListImages(client).all({ ids });
	const ratings = preparedListRatings(client).all({ ids });

	for (const metadataId of metadataIds) {
		relationsByMetadataId.set(metadataId, emptyRelationData());
	}

	for (const row of genres) relationsByMetadataId.get(row.metadataId)?.genres.push(row.data);

	for (const row of images) {
		relationsByMetadataId.get(row.metadataId)?.images.push({
			imageType: row.imageType,
			data: row.data,
		});
	}

	for (const row of ratings) {
		relationsByMetadataId.get(String(row.metadataId))?.rating.scores.push(row.data);
	}
}

/** Explicit-field projection: per-relation queries with exactly the requested columns. */
async function loadExplicitRelations<F extends string>(
	relationsByMetadataId: Map<string, MetadataRelationData>,
	client: RelationClient,
	metadataIds: string[],
	fields: FieldsConfig<F> | undefined,
	isDetailPage: boolean,
): Promise<void> {
	const includes = (rel: string) => shouldLoadRelation(fields, rel, isDetailPage);

	const [[collections, companies, genres, keywords, providers], [cast, crew, images, ratings, lockedFields]] = await Promise.all([
		loadJunctionRows(client, metadataIds, fields, includes),
		loadRelationRows(client, metadataIds, fields, includes),
	]);

	for (const metadataId of metadataIds) {
		relationsByMetadataId.set(metadataId, emptyRelationData());
	}

	for (const row of collections) relationsByMetadataId.get(row.metadataId)?.collections.push(row.data);

	for (const row of companies) relationsByMetadataId.get(row.metadataId)?.companies.push(row.data);

	for (const row of genres) relationsByMetadataId.get(row.metadataId)?.genres.push(row.data);

	for (const row of keywords) relationsByMetadataId.get(row.metadataId)?.keywords.push(row.data);

	for (const row of cast) {
		relationsByMetadataId.get(row.metadataId)?.cast.push({
			role: row.role ?? "",
			character: row.character ?? null,
			sortOrder: row.sortOrder ?? -1,
			data: row.data,
		});
	}

	for (const row of crew) {
		relationsByMetadataId.get(row.metadataId)?.crew.push({
			job: row.job ?? "",
			department: row.department ?? "",
			data: row.data,
		});
	}

	for (const row of images) {
		relationsByMetadataId.get(row.metadataId)?.images.push({
			imageType: row.imageType,
			data: row.data,
		});
	}

	for (const row of ratings) {
		relationsByMetadataId.get(String(row.metadataId))?.rating.scores.push(row.data);
	}

	for (const row of providers) relationsByMetadataId.get(row.metadataId)?.providers.push(row.data);

	for (const row of lockedFields) relationsByMetadataId.get(row.metadataId)?.lockedFields.push(row.field);

	for (const data of relationsByMetadataId.values()) {
		data.cast.sort((a, b) => a.sortOrder - b.sortOrder);
	}
}

export async function loadRelations<F extends string>(
	metadataIds: string[],
	tx?: DatabaseTransaction,
	fields?: FieldsConfig<F>,
	isDetailPage = false,
): Promise<Map<string, MetadataRelationData>> {
	const relationsByMetadataId = new Map<string, MetadataRelationData>();
	if (metadataIds.length === 0) return relationsByMetadataId;

	// Recurse on chunk boundaries so each relation query stays within SQLite's
	// bound-variable limit. Each metadata id lands in exactly one chunk, so the
	// merged map is identical to a single unbounded load.
	if (metadataIds.length > serverConstants.database.queryChunkSize) {
		for (const idsChunk of chunk(metadataIds, serverConstants.database.queryChunkSize)) {
			for (const [id, data] of await loadRelations(idsChunk, tx, fields, isDetailPage)) {
				relationsByMetadataId.set(id, data);
			}
		}

		return relationsByMetadataId;
	}

	const client = databaseFactory.getClient({ tx });

	if (!fields?.fields.length) {
		if (isDetailPage) {
			loadMergedDetailRelations(relationsByMetadataId, client, metadataIds);
		} else {
			loadBatchedListRelations(relationsByMetadataId, client, metadataIds);
		}

		return relationsByMetadataId;
	}

	await loadExplicitRelations(relationsByMetadataId, client, metadataIds, fields, isDetailPage);

	return relationsByMetadataId;
}

export function withRelations(metadata: typeof schema.metadata.$inferSelect, relations?: MetadataRelationData): MetadataWithRelation {
	const data = relations ?? emptyRelationData();

	return {
		...metadata,
		...data,
		cast: data.cast,
		rating: {
			avgScore: calculateAverageScore(data.rating.scores, systemSettingsStore.get("metadata.ratingAggregation")) ?? 0,
			scores: data.rating.scores,
		},
		lockedFields: data.lockedFields,
	};
}

function relationFields<F extends string>(fields: FieldsConfig<F> | undefined, relation: string): Set<string> | undefined {
	if (!fields?.fields.length) return undefined;

	if (QueryFields.includes(fields, relation)) return undefined;

	return new Set(fields.fields.filter((field) => field.startsWith(`${relation}.`)).map((field) => field.slice(relation.length + 1)));
}

function nestedRelationFields(fields: Set<string> | undefined, relation: string): Set<string> | undefined {
	if (!fields || fields.has(relation)) return undefined;

	const prefix = `${relation}.`;
	const result = new Set<string>();
	for (const field of fields) {
		if (field.startsWith(prefix)) result.add(field.slice(relation.length + 1));
	}

	return result;
}

function ratingFields<F extends string>(fields: FieldsConfig<F> | undefined): Set<string> | undefined {
	return nestedRelationFields(relationFields(fields, "rating"), "scores");
}

const selectColumnsCache = new WeakMap<object, Map<string, Record<string, unknown>>>();

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

	const requiredFields = new Set(required);
	const cacheKey = `${[...requested].toSorted().join(",")}|${[...requiredFields].toSorted().join(",")}`;
	let cachedByKey = selectColumnsCache.get(columns);
	if (!cachedByKey) {
		cachedByKey = new Map();
		selectColumnsCache.set(columns, cachedByKey);
	}

	const cached = cachedByKey.get(cacheKey);
	if (cached) return cached;

	const result = pickColumns(columns, requested, required);

	if (cachedByKey.size < 1000) cachedByKey.set(cacheKey, result);

	return result;
}

function shouldLoadRelation<F extends string>(fields: FieldsConfig<F> | undefined, relation: string, isDetailPage: boolean): boolean {
	if (fields?.fields.length) {
		return QueryFields.includes(fields, relation);
	}

	if (isDetailPage) return true;

	return relation === "images" || relation === "genres" || relation === "rating";
}

async function loadIf<T>(condition: boolean, load: () => T[] | Promise<T[]>): Promise<T[]> {
	return condition ? await load() : [];
}
