import type { FieldsConfig } from "@sdk/common/fields";
import type { MetadataWithRelation } from "@sdk/common/metadata.types";
import { eq, getTableColumns, inArray } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { serverConfig } from "@/server.config";
import { chunk } from "@/utils/array.utils";
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
	if (metadataIds.length > serverConfig.database.queryChunkSize) {
		for (const idsChunk of chunk(metadataIds, serverConfig.database.queryChunkSize)) {
			for (const [id, data] of await loadRelations(idsChunk, tx, fields, isDetailPage)) {
				relationsByMetadataId.set(id, data);
			}
		}

		return relationsByMetadataId;
	}

	const client = databaseFactory.getClient({ tx });
	const includes = (rel: string) => shouldLoadRelation(fields, rel, isDetailPage);

	const [collections, companies, genres, keywords, cast, crew, images, ratings, providers, lockedFields] = await Promise.all([
		loadIf(includes("collections"), async () =>
			client
				.select({
					metadataId: schema.metadataCollections.metadataId,
					data: selectColumns(relationFields(fields, "collections"), collectionColumns),
				})
				.from(schema.metadataCollections)
				.innerJoin(schema.collections, eq(schema.collections.id, schema.metadataCollections.collectionId))
				.where(inArray(schema.metadataCollections.metadataId, metadataIds)),
		),
		loadIf(includes("companies"), async () =>
			client
				.select({
					metadataId: schema.metadataCompanies.metadataId,
					data: selectColumns(relationFields(fields, "companies"), companyColumns),
				})
				.from(schema.metadataCompanies)
				.innerJoin(schema.companies, eq(schema.companies.id, schema.metadataCompanies.companyId))
				.where(inArray(schema.metadataCompanies.metadataId, metadataIds)),
		),
		loadIf(includes("genres"), async () =>
			client
				.select({
					metadataId: schema.metadataGenres.metadataId,
					data: selectColumns(relationFields(fields, "genres"), genreColumns),
				})
				.from(schema.metadataGenres)
				.innerJoin(schema.genres, eq(schema.genres.id, schema.metadataGenres.genreId))
				.where(inArray(schema.metadataGenres.metadataId, metadataIds)),
		),
		loadIf(includes("keywords"), async () =>
			client
				.select({
					metadataId: schema.metadataKeywords.metadataId,
					data: selectColumns(relationFields(fields, "keywords"), keywordColumns),
				})
				.from(schema.metadataKeywords)
				.innerJoin(schema.keywords, eq(schema.keywords.id, schema.metadataKeywords.keywordId))
				.where(inArray(schema.metadataKeywords.metadataId, metadataIds)),
		),
		loadIf(includes("cast"), async () =>
			client
				.select({
					metadataId: schema.metadataCast.metadataId,
					...selectColumns(relationFields(fields, "cast"), castColumns),
					data: selectColumns(nestedRelationFields(relationFields(fields, "cast"), "data"), personColumns),
				})
				.from(schema.metadataCast)
				.innerJoin(schema.people, eq(schema.people.id, schema.metadataCast.personId))
				.where(inArray(schema.metadataCast.metadataId, metadataIds)),
		),
		loadIf(includes("crew"), async () =>
			client
				.select({
					metadataId: schema.metadataCrew.metadataId,
					...selectColumns(relationFields(fields, "crew"), crewColumns),
					data: selectColumns(nestedRelationFields(relationFields(fields, "crew"), "data"), personColumns),
				})
				.from(schema.metadataCrew)
				.innerJoin(schema.people, eq(schema.people.id, schema.metadataCrew.personId))
				.where(inArray(schema.metadataCrew.metadataId, metadataIds)),
		),
		loadIf(includes("images"), async () =>
			client
				.select({
					metadataId: schema.metadataImages.metadataId,
					imageType: schema.metadataImages.imageType,
					data: selectColumns(nestedRelationFields(relationFields(fields, "images"), "data"), imageColumns),
				})
				.from(schema.metadataImages)
				.innerJoin(schema.images, eq(schema.images.id, schema.metadataImages.imageId))
				.where(inArray(schema.metadataImages.metadataId, metadataIds)),
		),
		loadIf(includes("rating"), async () =>
			client
				.select({
					metadataId: schema.metadataRatings.metadataId,
					data: selectColumns(ratingFields(fields), ratingColumns),
				})
				.from(schema.metadataRatings)
				.where(inArray(schema.metadataRatings.metadataId, metadataIds)),
		),
		loadIf(includes("providers"), async () =>
			client
				.select({
					metadataId: schema.metadataProviders.metadataId,
					data: selectColumns(relationFields(fields, "providers"), providerColumns),
				})
				.from(schema.metadataProviders)
				.innerJoin(schema.providers, eq(schema.providers.id, schema.metadataProviders.providerId))
				.where(inArray(schema.metadataProviders.metadataId, metadataIds)),
		),
		loadIf(includes("lockedFields"), async () =>
			client
				.select({
					metadataId: schema.metadataLockedFields.metadataId,
					field: schema.metadataLockedFields.field,
				})
				.from(schema.metadataLockedFields)
				.where(inArray(schema.metadataLockedFields.metadataId, metadataIds)),
		),
	]);

	for (const metadataId of metadataIds) {
		relationsByMetadataId.set(metadataId, {
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
		});
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

	return relationsByMetadataId;
}

export function withRelations(metadata: typeof schema.metadata.$inferSelect, relations?: MetadataRelationData): MetadataWithRelation {
	const data = relations ?? {
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

	return {
		...metadata,
		...data,
		cast: data.cast,
		rating: {
			avgScore: calculateAverageScore(data.rating.scores, serverConfig.metadata.ratingAggregation) ?? 0,
			scores: data.rating.scores,
		},
		lockedFields: data.lockedFields,
	};
}

export function rootFields<F extends string>(fields: FieldsConfig<F>): Set<string> {
	return new Set(fields.fields.filter((field) => !field.includes(".")));
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

export function selectColumns<T extends Record<string, unknown>>(
	requested: Set<string> | undefined,
	columns: T,
	required?: readonly string[],
): Partial<T>;

export function selectColumns(
	requested: Set<string> | undefined,
	columns: Record<string, unknown>,
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

	const result: Record<string, unknown> = {};
	for (const key of Object.keys(columns)) {
		if (requiredFields.has(key) || requested.has(key)) {
			result[key] = columns[key];
		}
	}

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

async function loadIf<T>(condition: boolean, load: () => Promise<T[]>): Promise<T[]> {
	return condition ? await load() : [];
}
