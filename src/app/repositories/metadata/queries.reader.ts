import type {
	CursorPaginatedResponse,
	CursorPaginationQuery,
	FieldsConfig,
	FieldsQuery,
	MetadataSorting,
	MetadataWithRelation,
	PaginatedResponse,
	PaginationQuery,
	ProviderEntityType,
	SelectFields,
} from "@reelvault/sdk/common";
import { and, asc, desc, eq, exists, gt, inArray, type SQL, sql } from "drizzle-orm";
import {
	buildCollectionOrderBy,
	type MetadataRepositoryFilters,
	metadataQueryMap,
	titleMatchFilter,
} from "@/app/repositories/metadata-filters.utils";
import type { MoreLikeThisSource } from "@/app/repositories/metadata-recommendations.reader";
import { getMoreLikeThis as recommendMoreLikeThis } from "@/app/repositories/metadata-recommendations.reader";
import { loadMergedDetailRow } from "@/app/repositories/metadata-relations/relations.loader";
import { loadRelations, withRelations } from "@/app/repositories/metadata-relations.repository";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import {
	type CreatedAtCursor,
	decodeCursorFor,
	KeysetCursor,
	keysetWhere,
} from "@/integrations/drizzle-orm/query/keyset/keyset-cursor.utils";
import { QueryPagination } from "@/integrations/drizzle-orm/query/pagination.utils";
import { QueryFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { QueryUtils } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { QuerySorting } from "@/integrations/drizzle-orm/query/parsing/sorting.parser";
import { mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { selectManyWithFields } from "@/integrations/drizzle-orm/query/table-access/field-projection.utils";
import { cachedCount, filterSignature } from "@/integrations/drizzle-orm/query/table-access/row-count.cache";
import { parseFieldsForRead } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { findFirstProviderLinkFor } from "@/integrations/drizzle-orm/utils/provider-link.reader";
import { toMap } from "@/utils/array.utils";

import {
	logger,
	type MetadataRootRow,
	type MetadataSelectArgs,
	type metadataColumns,
	metadataTable,
	preparedFindRootsById,
} from "./shared.utils";

/** Distinct non-empty `status` values in the catalog, sorted, for the status filter. */
export async function findDistinctStatuses(): Promise<string[]> {
	const rows = await databaseFactory
		.getClient()
		.selectDistinct({ status: schema.metadata.status })
		.from(schema.metadata)
		.where(sql`${schema.metadata.status} IS NOT NULL AND ${schema.metadata.status} <> ''`)
		.orderBy(asc(schema.metadata.status));

	return rows.flatMap((row) => (row.status ? [row.status] : []));
}

/** Keyset page of ids — lets "refresh all" stream the catalog instead of loading every id at once. */
export async function findIdsPage(afterId: string | undefined, limit: number, tx?: DatabaseTransaction): Promise<Array<{ id: string }>> {
	return await databaseFactory
		.getClient({ tx })
		.select({ id: schema.metadata.id })
		.from(schema.metadata)
		.where(afterId ? gt(schema.metadata.id, afterId) : undefined)
		.orderBy(asc(schema.metadata.id))
		.limit(limit);
}

function selectMetadata<F extends string>(args: MetadataSelectArgs<F>): Promise<Array<typeof schema.metadata.$inferSelect>>;

async function selectMetadata({
	fields,
	where,
	orderBy,
	limit,
	offset,
	requiredFields,
	tx,
}: MetadataSelectArgs<string>): Promise<unknown[]> {
	// `id` is always required; `createdAt` is added by cursor-mode callers so
	// the keyset cursor can be built from the projected row.
	return await selectManyWithFields(metadataTable, {
		fields,
		required: ["id", ...(requiredFields ?? [])],
		where,
		orderBy,
		limit,
		offset,
		tx,
	});
}

/**
 * Get all metadata with filtering and sorting
 */
export async function findMany<F extends string>({
	fields,
	where,
	orderBy,
	limit,
	offset,
	requiredFields,
	tx,
}: MetadataSelectArgs<F>): Promise<Array<SelectFields<MetadataWithRelation, F>>> {
	const data = await selectMetadata({ fields, where, orderBy, limit, offset, requiredFields, tx });

	return await hydrateRows(data, fields, tx);
}

export async function findManyWithCursor<F extends string>(
	args: MetadataSelectArgs<F>,
): Promise<{ data: Array<SelectFields<MetadataWithRelation, F>>; cursor?: CreatedAtCursor }> {
	const data = await selectMetadata(args);
	const last = data.at(-1);

	return {
		data: await hydrateRows(data, args.fields, args.tx),
		...(last ? { cursor: { createdAt: last.createdAt.getTime(), id: last.id } } : {}),
	};
}

/** Loads the relation graph for a page of metadata rows and applies the field selection. */
async function hydrateRows<F extends string>(
	data: Array<typeof schema.metadata.$inferSelect>,
	fields?: FieldsConfig<F>,
	tx?: DatabaseTransaction,
): Promise<Array<SelectFields<MetadataWithRelation, F>>> {
	const relations = await loadRelations(
		data.map((metadata) => metadata.id),
		tx,
		fields,
	);

	return data.map((item) => QueryFields.apply(withRelations(item, relations.get(item.id)), fields));
}

export async function findPage<F extends string>(
	query?: CursorPaginationQuery & FieldsQuery<F> & MetadataRepositoryFilters & MetadataSorting,
): Promise<CursorPaginatedResponse<SelectFields<MetadataWithRelation, F>>> {
	const { pagination, fields, sorting, filters } = QueryUtils.parseWithFilters<F, MetadataRepositoryFilters, MetadataSorting>(query);
	const where = QueryUtils.buildWhereConditions(filters, metadataQueryMap.filters);
	const cursorMode =
		(query?.cursor !== undefined || query?.sortBy === "createdAt") &&
		(sorting?.sortBy === "createdAt" || !sorting?.sortBy) &&
		(sorting?.sortOrder === "desc" || !sorting?.sortOrder);

	const cursor = decodeCursorFor(query?.cursor, cursorMode, "Pagination cursor requires descending createdAt sorting");
	const cursorWhere = cursor ? keysetWhere(schema.metadata.createdAt, schema.metadata.id, cursor) : undefined;
	let combinedWhere = where;
	if (cursorWhere) {
		combinedWhere = where ? and(where, cursorWhere) : cursorWhere;
	}

	let orderBy: SQL | undefined;
	if (cursorMode) {
		orderBy = sql`${desc(schema.metadata.createdAt)}, ${desc(schema.metadata.id)}`;
	} else if (sorting?.sortBy === "collectionOrder") {
		orderBy = buildCollectionOrderBy(filters?.collectionIds, sorting.sortOrder ?? "asc");
	} else {
		const baseOrderBy = QueryUtils.buildOrderBy(sorting, metadataQueryMap.orderBy, metadataQueryMap.defaults);
		// Tiebreaker keeps offset pagination deterministic for non-unique keys.
		orderBy = baseOrderBy
			? QuerySorting.withTiebreaker(baseOrderBy, schema.metadata.id, QueryUtils.resolveSortOrder(sorting, metadataQueryMap.defaults))
			: undefined;
	}

	const requiredFields: Array<keyof typeof metadataColumns> | undefined = cursorMode ? ["createdAt"] : undefined;
	const findManyArgs = {
		where: combinedWhere,
		orderBy,
		limit: pagination.limit,
		offset: cursorMode ? 0 : pagination.offset,
		requiredFields,
		fields,
	};
	const countPromise = cachedCount("metadata", filterSignature(filters, metadataQueryMap.filters), () => metadataTable.count({ where }));

	if (cursorMode) {
		const [total, keysetResult] = await Promise.all([countPromise, findManyWithCursor(findManyArgs)]);
		const response = QueryPagination.createResponse({
			total,
			pagination: { ...pagination, page: 1, offset: 0 },
			data: keysetResult.data,
		});
		if (keysetResult.data.length < pagination.limit || !keysetResult.cursor) return response;

		return { ...response, nextCursor: KeysetCursor.encode(keysetResult.cursor) };
	}

	const [total, data] = await Promise.all([countPromise, findMany(findManyArgs)]);

	return QueryPagination.createResponse({
		total,
		pagination,
		data,
	});
}

export async function findByIdForRead<F extends string>(
	metadataId: string,
	query?: FieldsQuery<F>,
): Promise<SelectFields<MetadataWithRelation, F> | undefined> {
	return await findById({ primaryId: metadataId, fields: parseFieldsForRead(query) });
}

export async function findProviderDetails(metadataId: string) {
	return await findById({ primaryId: metadataId, fields: QueryFields.parse({ fields: "id,type,primaryProviderId,providers" }) });
}

/**
 * Full flat metadata row with zero relation queries. findByIdForRead without
 * fields runs the detail-page relation load (collections/companies/genres/
 * keywords/cast/crew/images/ratings/providers/lockedFields) — callers that
 * only ship the root row (e.g. the playback view) must use this instead.
 */
export async function findRootsById(metadataId: string): Promise<typeof schema.metadata.$inferSelect | undefined> {
	const [row] = await preparedFindRootsById(databaseFactory.getClient()).execute({ id: metadataId });

	return row;
}

/** Which of the given ids exist in the catalog; a lightweight check for batch writes. */
export async function findExistingIds(metadataIds: readonly string[]): Promise<Set<string>> {
	if (metadataIds.length === 0) return new Set();

	const rows = await mapChunked([...metadataIds], (idChunk) =>
		databaseFactory.getClient().select({ id: schema.metadata.id }).from(schema.metadata).where(inArray(schema.metadata.id, idChunk)),
	);

	return new Set(rows.map((row) => row.id));
}

/** Full metadata rows with default relations (images, genres, rating) for a set of ids. */
export async function findManyByIdsWithRelations(
	metadataIds: readonly string[],
	tx?: DatabaseTransaction,
): Promise<MetadataWithRelation[]> {
	if (metadataIds.length === 0) return [];

	return await mapChunked([...metadataIds], (idChunk) => findMany({ where: inArray(schema.metadata.id, idChunk), tx }));
}

/** Local existence probe by exact title (or original title) and type. */
export async function findByTitleAndType(type: "movie" | "tv_show", title: string) {
	return await findFirst({
		where: and(eq(schema.metadata.type, type), titleMatchFilter(title, "exact")),
		fields: QueryFields.parse({ fields: "id,title,releaseDate,stableKey" }),
	});
}

/** First provider link (external id + provider name) for a metadata row. */
export async function findFirstProviderLink(metadataId: string): Promise<{ externalId: string; name: string } | undefined> {
	return await findFirstProviderLinkFor(schema.metadataProviders, schema.metadataProviders.metadataId, metadataId);
}

/**
 * Batch lookup of metadata rows by one provider's external ids, with a media
 * file count per title — feeds plugin availability checks in a single query
 * instead of N lookups. Chunked because SQLite is synchronous and `inArray`
 * lists are unbounded.
 */
export async function findByProviderExternalIds({
	providerName,
	entityType,
	externalIds,
}: {
	providerName: string;
	entityType: ProviderEntityType;
	externalIds: readonly string[];
}): Promise<Array<{ externalId: string; metadata: MetadataRootRow; fileCount: number }>> {
	const ids = [...new Set(externalIds.filter((id) => id.trim().length > 0))];
	if (ids.length === 0) return [];

	return await mapChunked(ids, (idChunk) =>
		databaseFactory
			.getClient()
			.select({
				externalId: schema.providers.externalId,
				metadata: schema.metadata,
				fileCount: sql<number>`count(${schema.mediaFiles.id})`,
			})
			.from(schema.providers)
			.innerJoin(schema.metadataProviders, eq(schema.metadataProviders.providerId, schema.providers.id))
			.innerJoin(schema.metadata, eq(schema.metadataProviders.metadataId, schema.metadata.id))
			.leftJoin(schema.mediaFiles, eq(schema.mediaFiles.metadataId, schema.metadata.id))
			.where(
				and(
					eq(schema.providers.name, providerName),
					eq(schema.providers.entityType, entityType),
					inArray(schema.providers.externalId, idChunk),
				),
			)
			.groupBy(schema.providers.externalId, schema.metadata.id),
	);
}

export async function getLockedFields(metadataId: string, tx?: DatabaseTransaction): Promise<string[]> {
	const client = databaseFactory.getClient({ tx });
	const rows = await client
		.select({ field: schema.metadataLockedFields.field })
		.from(schema.metadataLockedFields)
		.where(eq(schema.metadataLockedFields.metadataId, metadataId));

	return rows.map((r) => r.field);
}

export async function findSimilarPage<F extends string>(
	metadataId: string,
	query?: PaginationQuery & FieldsQuery<F>,
	source?: SelectFields<MetadataWithRelation, string>,
): Promise<PaginatedResponse<SelectFields<MetadataWithRelation, F>>> {
	const { pagination, fields } = QueryUtils.parseStandard(query);
	const { total, data } = await getMoreLikeThis({ metadataId, source, limit: pagination.limit, offset: pagination.offset, fields });

	return QueryPagination.createResponse({ total, pagination, data });
}

/**
 * Get metadata by ID
 */
export async function findFirst<F extends string>({
	where,
	fields,
	tx,
}: {
	where?: SQL | undefined;
	fields?: FieldsConfig<F> | undefined;
	tx?: DatabaseTransaction | undefined;
}): Promise<SelectFields<MetadataWithRelation, F> | undefined> {
	const metadata = (await selectMetadata({ fields, where, limit: 1, tx }))[0];
	if (!metadata) return undefined;

	const relations = await loadRelations([metadata.id], tx, fields, true);

	return QueryFields.apply(withRelations(metadata, relations.get(metadata.id)), fields);
}

export async function findById<F extends string>({
	primaryId,
	fields,
	tx,
}: {
	primaryId: string;
	fields?: FieldsConfig<F> | undefined;
	tx?: DatabaseTransaction | undefined;
}): Promise<SelectFields<MetadataWithRelation, F> | undefined> {
	// Default projection: the root row and every relation ride one prepared
	// statement instead of `SELECT *` plus the merged relation read.
	if (!fields?.fields.length) {
		const merged = loadMergedDetailRow(databaseFactory.getClient({ tx }), primaryId);
		if (!merged) return undefined;

		return QueryFields.apply(withRelations(merged.metadata, merged.relationData), fields);
	}

	const metadata = await metadataTable.selectFirstById({ primaryId, tx });
	if (!metadata) return undefined;

	const relations = await loadRelations([metadata.id], tx, fields, true);

	return QueryFields.apply(withRelations(metadata, relations.get(metadata.id)), fields);
}

/**
 * Recently-added ids for one type: ranked by the latest media-file creation
 * (the correlation is served by `media_files_metadata_created_idx`) and limited
 * before the rows are fetched.
 */
async function rankRecentlyAddedIds(type: "movie" | "tv_show", limit: number): Promise<string[]> {
	const client = databaseFactory.getClient();
	// Rank ids by their latest media-file creation with a correlated MAX
	// (`media_files_metadata_created_idx` serves the seek). The previous
	// derived-table aggregate materialized every media file of the requested
	// types before the LIMIT; the full rows are then fetched for the top ids
	// only. Measured on 20k titles: 19.2 ms -> 8.6 ms per call.
	const ranked = await client
		.select({
			id: schema.metadata.id,
			latestCreatedAt:
				sql`(SELECT MAX(${schema.mediaFiles.createdAt}) FROM ${schema.mediaFiles} WHERE ${schema.mediaFiles.metadataId} = ${schema.metadata.id})`.as(
					"latest_created_at",
				),
		})
		.from(schema.metadata)
		.where(
			and(
				inArray(schema.metadata.type, [type]),
				exists(client.select({ one: sql`1` }).from(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, schema.metadata.id))),
			),
		)
		.orderBy(desc(sql`latest_created_at`), desc(schema.metadata.id))
		.limit(limit);

	return ranked.map((row) => row.id);
}

/**
 * Recently-added titles for several types in one pass: each type ranks its own
 * top ids, then one row read and one relation load hydrate all of them together.
 * Discover asks for movies and shows per build, so the shared reads replace two
 * full hydrations (10 → 6 statements, same order and payload).
 */
export async function findRecentlyAddedByTypes(
	types: Array<"movie" | "tv_show">,
	limit: number,
): Promise<Map<"movie" | "tv_show", MetadataWithRelation[]>> {
	const idGroups = await Promise.all(types.map(async (type) => await rankRecentlyAddedIds(type, limit)));
	const ids = [...new Set(idGroups.flat())];
	const result = new Map<"movie" | "tv_show", MetadataWithRelation[]>();
	for (const type of types) result.set(type, []);
	if (ids.length === 0) return result;

	const rowsById = toMap(await metadataTable.selectMany({ where: inArray(schema.metadata.id, ids) }), (row) => row.id);
	const relations = await loadRelations(ids);

	for (const [index, type] of types.entries()) {
		const group = idGroups[index] ?? [];
		result.set(
			type,
			group.flatMap((id) => {
				const row = rowsById.get(id);

				return row ? [withRelations(row, relations.get(id))] : [];
			}),
		);
	}

	return result;
}

export async function getMoreLikeThis<F extends string>(args: {
	metadataId: string;
	source?: MoreLikeThisSource | undefined;
	fields?: FieldsConfig<F> | undefined;
	limit: number;
	offset: number;
	tx?: DatabaseTransaction | undefined;
}): Promise<{ total: number; data: Array<SelectFields<MetadataWithRelation, F>> }> {
	return await recommendMoreLikeThis({ logger, findMany: (p) => findMany(p) }, args);
}
