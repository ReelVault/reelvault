import type {
	CreateMetadata,
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
import type { ProviderMetadataResult } from "@reelvault/sdk/plugin";
import { and, asc, desc, eq, exists, getTableColumns, gt, inArray, notExists, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { createPreparedQuery } from "@/database/prepared-queries";
import { providersRepository } from "@/database/repositories/providers.repository";
import { schema } from "@/database/schema";
import {
	cachedCount,
	defineTableAccess,
	filterSignature,
	forEachChunked,
	mapChunked,
	parseFieldsForRead,
	selectManyWithFields,
} from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { type CreatedAtCursor, decodeCursorFor, KeysetCursor, keysetWhere } from "@/database/utils/keyset-cursor";
import { findMediaCleanupData } from "@/database/utils/media-cleanup";
import { toMetadataValues } from "@/database/utils/metadata-values";
import { QueryPagination } from "@/database/utils/pagination";
import { findFirstProviderLinkFor } from "@/database/utils/provider-link";
import { QueryUtils } from "@/database/utils/query-parser";
import { createLocalMetadataStableKey, createProviderStableKey } from "@/database/utils/stable-key";
import { runInTransaction } from "@/database/utils/transaction";
import { hasEntry, toMap } from "@/utils/array.utils";
import { NotFoundError, ValidationError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { buildCollectionOrderBy, type MetadataRepositoryFilters, metadataQueryMap, titleMatchFilter } from "./metadata-filters";
import type { MoreLikeThisSource } from "./metadata-recommendations";
import { getMoreLikeThis } from "./metadata-recommendations";
import { loadRelations, withRelations } from "./metadata-relations";

const metadataCast = defineTableAccess("metadataCast", {
	primaryKeyColumn: "personId",
});
const metadataCollections = defineTableAccess("metadataCollections", {
	primaryKeyColumn: "collectionId",
});
const metadataCompanies = defineTableAccess("metadataCompanies", {
	primaryKeyColumn: "companyId",
});
const metadataCrew = defineTableAccess("metadataCrew", {
	primaryKeyColumn: "personId",
});
const metadataGenres = defineTableAccess("metadataGenres", {
	primaryKeyColumn: "genreId",
});
const metadataImages = defineTableAccess("metadataImages", {
	primaryKeyColumn: "imageId",
});
const metadataKeywords = defineTableAccess("metadataKeywords", {
	primaryKeyColumn: "keywordId",
});
const metadataProviders = defineTableAccess("metadataProviders", {
	primaryKeyColumn: "providerId",
});
const metadataRatings = defineTableAccess("metadataRatings", {
	primaryKeyColumn: "metadataId",
});

async function findMetadataProvider({
	providerId,
	externalId,
	name,
	entityType,
	tx,
}: {
	providerId?: string | undefined;
	externalId?: string | undefined;
	name?: string | undefined;
	entityType?: ProviderEntityType | undefined;
	tx?: DatabaseTransaction | undefined;
}) {
	const client = databaseFactory.getClient({ tx });
	let where: SQL | undefined;
	if (providerId) {
		where = eq(metadataProviders.table.providerId, providerId);
	} else if (externalId && name && entityType) {
		where = and(eq(schema.providers.externalId, externalId), eq(schema.providers.name, name), eq(schema.providers.entityType, entityType));
	}

	if (!where)
		throw new ValidationError("Metadata provider lookup requires a provider ID or a complete external identity", {
			code: "metadata_provider_lookup_requires",
		});

	const [existingLink] = await client
		.select({ metadata: schema.metadata })
		.from(schema.metadata)
		.innerJoin(metadataProviders.table, eq(metadataProviders.table.metadataId, schema.metadata.id))
		.innerJoin(schema.providers, eq(metadataProviders.table.providerId, schema.providers.id))
		.where(where)
		.limit(1);

	return existingLink;
}

/** Falls back to the primary provider when no explicit link list is supplied, and de-duplicates by (name, externalId). */
function normalizeProviderLinks(
	primaryProviderName: string,
	primaryExternalId: string,
	providers?: ReadonlyArray<{ name: string; externalId: string }>,
): Array<{ name: string; externalId: string }> {
	const source = providers && providers.length > 0 ? providers : [{ name: primaryProviderName, externalId: primaryExternalId }];
	const seen = new Set<string>();
	const links: Array<{ name: string; externalId: string }> = [];
	for (const provider of source) {
		const key = `${provider.name}\u0000${provider.externalId}`;
		if (seen.has(key)) continue;

		seen.add(key);
		links.push({ name: provider.name, externalId: provider.externalId });
	}

	return links;
}

const metadataTable = defineTableAccess("metadata", {
	primaryKeyColumn: "id",
});

const metadataColumns = getTableColumns(schema.metadata);

// Fixed-shape PK reads for hot paths (Faza 3 pilot): one prepared query per
// connection, reused across calls.
const preparedFindTypeById = createPreparedQuery((client) =>
	client
		.select({ type: schema.metadata.type, numberingMode: schema.metadata.numberingMode })
		.from(schema.metadata)
		.where(eq(schema.metadata.id, sql.placeholder("id")))
		.limit(1)
		.prepare(),
);

const preparedFindRootsById = createPreparedQuery((client) =>
	client
		.select()
		.from(schema.metadata)
		.where(eq(schema.metadata.id, sql.placeholder("id")))
		.limit(1)
		.prepare(),
);

const preparedFindNumberingModeById = createPreparedQuery((client) =>
	client
		.select({ numberingMode: schema.metadata.numberingMode })
		.from(schema.metadata)
		.where(eq(schema.metadata.id, sql.placeholder("id")))
		.limit(1)
		.prepare(),
);

/** Args shared by the private selectMetadata and the public findMany/findManyWithCursor. */
interface MetadataSelectArgs<F extends string> {
	fields?: FieldsConfig<F> | undefined;
	where?: SQL | undefined;
	orderBy?: SQL | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
	requiredFields?: Array<keyof typeof metadataColumns> | undefined;
	tx?: DatabaseTransaction | undefined;
}

/** Flat metadata row (no relations) — the DTO returned by `findRootsById`. */
export type MetadataRootRow = typeof schema.metadata.$inferSelect;

class MetadataRepository {
	private readonly logger = createLogger(this.constructor.name);
	readonly table = schema.metadata;
	readonly primaryKeyColumn = metadataTable.primaryKeyColumn;
	readonly query = metadataTable.query;
	readonly selectMany = metadataTable.selectMany;
	readonly selectFirst = metadataTable.selectFirst;
	readonly findOrCreate = metadataTable.findOrCreate;
	readonly insert = metadataTable.insert;
	readonly update = metadataTable.update;
	readonly delete = metadataTable.delete;
	readonly count = metadataTable.count;
	readonly isExists = metadataTable.isExists;
	readonly insertCast = metadataCast.insert;
	readonly deleteCast = metadataCast.delete;
	readonly insertCollections = metadataCollections.insert;
	readonly deleteCollections = metadataCollections.delete;
	readonly insertCompanies = metadataCompanies.insert;
	readonly deleteCompanies = metadataCompanies.delete;
	readonly insertCrew = metadataCrew.insert;
	readonly deleteCrew = metadataCrew.delete;
	readonly insertGenres = metadataGenres.insert;
	readonly deleteGenres = metadataGenres.delete;
	readonly insertImages = metadataImages.insert;
	readonly deleteImages = metadataImages.delete;
	readonly insertKeywords = metadataKeywords.insert;
	readonly deleteKeywords = metadataKeywords.delete;
	readonly insertProviders = metadataProviders.insert;
	readonly deleteProviders = metadataProviders.delete;
	readonly findProvider = findMetadataProvider;
	readonly insertRatings = metadataRatings.insert;
	readonly deleteRatings = metadataRatings.delete;

	/** Keyset page of ids — lets "refresh all" stream the catalog instead of loading every id at once. */
	async findIdsPage(afterId: string | undefined, limit: number, tx?: DatabaseTransaction): Promise<Array<{ id: string }>> {
		return await databaseFactory
			.getClient({ tx })
			.select({ id: this.table.id })
			.from(this.table)
			.where(afterId ? gt(this.table.id, afterId) : undefined)
			.orderBy(asc(this.table.id))
			.limit(limit);
	}

	private selectMetadata<F extends string>(args: MetadataSelectArgs<F>): Promise<Array<typeof schema.metadata.$inferSelect>>;
	private async selectMetadata({
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
	async findMany<F extends string>({
		fields,
		where,
		orderBy,
		limit,
		offset,
		requiredFields,
		tx,
	}: MetadataSelectArgs<F>): Promise<Array<SelectFields<MetadataWithRelation, F>>> {
		const data = await this.selectMetadata({ fields, where, orderBy, limit, offset, requiredFields, tx });

		return await this.hydrateRows(data, fields, tx);
	}

	async findManyWithCursor<F extends string>(
		args: MetadataSelectArgs<F>,
	): Promise<{ data: Array<SelectFields<MetadataWithRelation, F>>; cursor?: CreatedAtCursor }> {
		const data = await this.selectMetadata(args);
		const last = data.at(-1);

		return {
			data: await this.hydrateRows(data, args.fields, args.tx),
			...(last ? { cursor: { createdAt: last.createdAt.getTime(), id: last.id } } : {}),
		};
	}

	/** Loads the relation graph for a page of metadata rows and applies the field selection. */
	private async hydrateRows<F extends string>(
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

	async findPage<F extends string>(
		query?: CursorPaginationQuery & FieldsQuery<F> & MetadataRepositoryFilters & MetadataSorting,
	): Promise<CursorPaginatedResponse<SelectFields<MetadataWithRelation, F>>> {
		const { pagination, fields, sorting, filters } = QueryUtils.parseWithFilters<F, MetadataRepositoryFilters, MetadataSorting>(query);
		const where = QueryUtils.buildWhereConditions(filters, metadataQueryMap.filters);
		const cursorMode =
			(query?.cursor !== undefined || query?.sortBy === "createdAt") &&
			(sorting?.sortBy === "createdAt" || !sorting?.sortBy) &&
			(sorting?.sortOrder === "desc" || !sorting?.sortOrder);

		const cursor = decodeCursorFor(query?.cursor, cursorMode, "Pagination cursor requires descending createdAt sorting");
		const cursorWhere = cursor ? keysetWhere(this.table.createdAt, this.table.id, cursor) : undefined;
		let combinedWhere = where;
		if (cursorWhere) {
			combinedWhere = where ? and(where, cursorWhere) : cursorWhere;
		}

		let orderBy: SQL | undefined;
		if (cursorMode) {
			orderBy = sql`${desc(this.table.createdAt)}, ${desc(this.table.id)}`;
		} else if (sorting?.sortBy === "collectionOrder") {
			orderBy = buildCollectionOrderBy(filters?.collectionIds, sorting.sortOrder ?? "asc");
		} else {
			const baseOrderBy = QueryUtils.buildOrderBy(sorting, metadataQueryMap.orderBy, metadataQueryMap.defaults);
			// Tiebreaker keeps offset pagination deterministic for non-unique keys.
			orderBy = baseOrderBy ? sql`${baseOrderBy}, ${this.table.id}` : undefined;
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
		const countPromise = cachedCount("metadata", filterSignature(filters, metadataQueryMap.filters), () => this.count({ where }));

		if (cursorMode) {
			const [total, keysetResult] = await Promise.all([countPromise, this.findManyWithCursor(findManyArgs)]);
			const response = QueryPagination.createResponse({
				total,
				pagination: { ...pagination, page: 1, offset: 0 },
				data: keysetResult.data,
			});
			if (keysetResult.data.length < pagination.limit || !keysetResult.cursor) return response;

			return { ...response, nextCursor: KeysetCursor.encode(keysetResult.cursor) };
		}

		const [total, data] = await Promise.all([countPromise, this.findMany(findManyArgs)]);

		return QueryPagination.createResponse({
			total,
			pagination,
			data,
		});
	}

	async findByIdForRead<F extends string>(
		metadataId: string,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<MetadataWithRelation, F> | undefined> {
		return await this.findById({ primaryId: metadataId, fields: parseFieldsForRead(query) });
	}

	async findProviderDetails(metadataId: string) {
		return await this.findById({ primaryId: metadataId, fields: QueryFields.parse({ fields: "id,type,primaryProviderId,providers" }) });
	}

	async findTypeById(metadataId: string) {
		const [row] = await preparedFindTypeById(databaseFactory.getClient()).execute({ id: metadataId });

		return row;
	}

	async findNumberingModeById(metadataId: string) {
		const [row] = await preparedFindNumberingModeById(databaseFactory.getClient()).execute({ id: metadataId });

		return row;
	}

	/**
	 * Full flat metadata row with zero relation queries. findByIdForRead without
	 * fields runs the detail-page relation load (collections/companies/genres/
	 * keywords/cast/crew/images/ratings/providers/lockedFields) — callers that
	 * only ship the root row (e.g. the playback view) must use this instead.
	 */
	async findRootsById(metadataId: string): Promise<typeof schema.metadata.$inferSelect | undefined> {
		const [row] = await preparedFindRootsById(databaseFactory.getClient()).execute({ id: metadataId });

		return row;
	}

	/** Full metadata rows with default relations (images, genres, rating) for a set of ids. */
	async findManyByIdsWithRelations(metadataIds: readonly string[], tx?: DatabaseTransaction): Promise<MetadataWithRelation[]> {
		if (metadataIds.length === 0) return [];

		return await mapChunked([...metadataIds], (idChunk) => this.findMany({ where: inArray(schema.metadata.id, idChunk), tx }));
	}

	/** Local existence probe by exact title (or original title) and type. */
	async findByTitleAndType(type: "movie" | "tv_show", title: string) {
		return await this.findFirst({
			where: and(eq(this.table.type, type), titleMatchFilter(title, "exact")),
			fields: QueryFields.parse({ fields: "id,title,releaseDate,stableKey" }),
		});
	}

	/** First provider link (external id + provider name) for a metadata row. */
	async findFirstProviderLink(metadataId: string): Promise<{ externalId: string; name: string } | undefined> {
		return await findFirstProviderLinkFor(schema.metadataProviders, schema.metadataProviders.metadataId, metadataId);
	}

	/**
	 * Batch lookup of metadata rows by one provider's external ids, with a media
	 * file count per title — feeds plugin availability checks in a single query
	 * instead of N lookups. Chunked because SQLite is synchronous and `inArray`
	 * lists are unbounded.
	 */
	async findByProviderExternalIds({
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

	/**
	 * A season/episode sync reported fallback-language content for this title —
	 * raise the series-level flag so the admin missing-translation filter finds
	 * it. Deliberately never clears the flag: child syncs see partial data, only
	 * a full metadata refresh (own metadata + all seasons) may clear it.
	 */
	async flagMissingTranslation(metadataId: string, tx?: DatabaseTransaction): Promise<void> {
		await this.update({ primaryId: metadataId, values: { hasMissingTranslation: true }, tx });
	}

	async getLockedFields(metadataId: string, tx?: DatabaseTransaction): Promise<string[]> {
		const client = databaseFactory.getClient({ tx });
		const rows = await client
			.select({ field: schema.metadataLockedFields.field })
			.from(schema.metadataLockedFields)
			.where(eq(schema.metadataLockedFields.metadataId, metadataId));

		return rows.map((r) => r.field);
	}

	async setLockedFields(metadataId: string, fields: readonly string[], tx?: DatabaseTransaction): Promise<void> {
		await runInTransaction(tx, async (transaction) => {
			const client = databaseFactory.getClient({ tx: transaction });
			await client.delete(schema.metadataLockedFields).where(eq(schema.metadataLockedFields.metadataId, metadataId));
			if (fields.length > 0) {
				const uniqueFields: string[] = [];
				const seen = new Set<string>();
				for (const f of fields) {
					const trimmed = f.trim();
					if (trimmed.length === 0 || seen.has(trimmed)) continue;

					seen.add(trimmed);
					uniqueFields.push(trimmed);
				}

				if (uniqueFields.length > 0) {
					await client.insert(schema.metadataLockedFields).values(
						uniqueFields.map((field) => ({
							metadataId,
							field,
						})),
					);
				}
			}
		});
	}

	async createAndRead<F extends string>(
		body: CreateMetadata,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<MetadataWithRelation, F> | undefined> {
		const { fields } = QueryUtils.parseStandard(query);
		const { lockedFields, ...metadataValues } = body;
		const metadata = await databaseFactory.transaction(async (tx) => {
			const created = await this.findOrCreateByIdentity({
				title: metadataValues.title,
				type: metadataValues.type,
				releaseDate: metadataValues.releaseDate,
				values: metadataValues,
				tx,
			});
			if (created && lockedFields && lockedFields.length > 0) {
				await this.setLockedFields(created.id, lockedFields, tx);
			}

			return created;
		});

		return metadata ? await this.findById({ primaryId: metadata.id, fields }) : undefined;
	}

	async updateAndRead<F extends string>(
		metadataId: string,
		values: CreateMetadata | Partial<CreateMetadata>,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<MetadataWithRelation, F> | undefined> {
		const { fields } = QueryUtils.parseStandard(query);
		const { lockedFields, ...metadataValues } = values;

		await databaseFactory.transaction(async (tx) => {
			if (hasEntry(metadataValues)) {
				await this.update({ primaryId: metadataId, values: metadataValues, tx });
			}

			if (lockedFields !== undefined) {
				await this.setLockedFields(metadataId, lockedFields, tx);
			}
		});

		return await this.findById({ primaryId: metadataId, fields });
	}

	async deleteAndGetCleanup(metadataId: string) {
		return await databaseFactory.transaction(async (tx) => {
			const cleanup = await this.findMediaFileCleanupData(metadataId, tx);
			await this.deleteWithMediaFiles({ metadataId, tx });

			return cleanup;
		});
	}

	async findSimilarPage<F extends string>(
		metadataId: string,
		query?: PaginationQuery & FieldsQuery<F>,
		source?: SelectFields<MetadataWithRelation, string>,
	): Promise<PaginatedResponse<SelectFields<MetadataWithRelation, F>>> {
		const { pagination, fields } = QueryUtils.parseStandard(query);
		const { total, data } = await this.getMoreLikeThis({ metadataId, source, limit: pagination.limit, offset: pagination.offset, fields });

		return QueryPagination.createResponse({ total, pagination, data });
	}

	/**
	 * Get metadata by ID
	 */
	async findFirst<F extends string>({
		where,
		fields,
		tx,
	}: {
		where?: SQL | undefined;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<MetadataWithRelation, F> | undefined> {
		const metadata = (await this.selectMetadata({ fields, where, limit: 1, tx }))[0];
		if (!metadata) return undefined;

		const relations = await loadRelations([metadata.id], tx, fields, true);

		return QueryFields.apply(withRelations(metadata, relations.get(metadata.id)), fields);
	}

	async findById<F extends string>({
		primaryId,
		fields,
		tx,
	}: {
		primaryId: string;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<MetadataWithRelation, F> | undefined> {
		return await this.findFirst({
			where: eq(this.primaryKeyColumn, primaryId),
			fields,
			tx,
		});
	}

	async findOrCreateByIdentity({
		title,
		type,
		releaseDate,
		values,
		tx,
	}: {
		title: CreateMetadata["title"];
		type: CreateMetadata["type"];
		releaseDate: CreateMetadata["releaseDate"];
		values: CreateMetadata;
		tx?: DatabaseTransaction | undefined;
	}) {
		return await this.findOrCreate({
			where: and(eq(this.table.title, title), eq(this.table.type, type), eq(this.table.releaseDate, releaseDate)),
			values: {
				...values,
				stableKey: createLocalMetadataStableKey({ title, type, releaseDate }),
			},
			tx,
		});
	}

	findRecentlyAddedByType(type: "movie" | "tv_show", limit: number) {
		return this.findRecentlyAdded([type], limit);
	}

	async findRecentlyAdded(types: Array<"movie" | "tv_show">, limit: number): Promise<MetadataWithRelation[]> {
		const client = databaseFactory.getClient();
		// Rank ids by their latest media-file creation with a correlated MAX
		// (`media_files_metadata_created_idx` serves the seek). The previous
		// derived-table aggregate materialized every media file of the requested
		// types before the LIMIT; the full rows are then fetched for the top ids
		// only. Measured on 20k titles: 19.2 ms -> 8.6 ms per call.
		const ranked = await client
			.select({
				id: this.table.id,
				latestCreatedAt:
					sql`(SELECT MAX(${schema.mediaFiles.createdAt}) FROM ${schema.mediaFiles} WHERE ${schema.mediaFiles.metadataId} = ${this.table.id})`.as(
						"latest_created_at",
					),
			})
			.from(this.table)
			.where(
				and(
					inArray(this.table.type, types),
					exists(client.select({ one: sql`1` }).from(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, this.table.id))),
				),
			)
			.orderBy(desc(sql`latest_created_at`))
			.limit(limit);
		if (ranked.length === 0) return [];

		const ids = ranked.map((row) => row.id);
		const rowsById = toMap(await this.selectMany({ where: inArray(this.table.id, ids) }), (row) => row.id);
		const rows = ids.flatMap((id) => {
			const row = rowsById.get(id);

			return row ? [row] : [];
		});

		const relations = await loadRelations(ids);

		return rows.map((item) => withRelations(item, relations.get(item.id)));
	}

	/** Orphan metadata ids (no linked media files), ascending by id, keyset-paged via `afterId`. */
	async findOrphanIds(limit?: number, afterId?: string, tx?: DatabaseTransaction): Promise<string[]> {
		const client = databaseFactory.getClient({ tx });
		const conditions = [
			notExists(client.select({ one: sql`1` }).from(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, this.table.id))),
			...(afterId ? [gt(this.table.id, afterId)] : []),
		];
		const query = client
			.select({ id: this.table.id })
			.from(this.table)
			.where(and(...conditions))
			.orderBy(asc(this.table.id));
		const rows = limit === undefined ? await query : await query.limit(limit);

		return rows.map((r) => r.id);
	}

	async deleteOrphansByIds(orphanIds: string[], tx?: DatabaseTransaction): Promise<number> {
		if (orphanIds.length === 0) return 0;

		return await runInTransaction(tx, async (targetTx) => {
			const client = databaseFactory.getClient({ tx: targetTx });
			let deletedCount = 0;
			await forEachChunked(orphanIds, async (idChunk) => {
				// Re-check orphan status at delete time: a media file attached since
				// the page was fetched would make the FK abort the whole purge.
				// `.returning()` counts actual deletions — `changes` also counts
				// FTS trigger rows on this table.
				const deletedRows = await client
					.delete(this.table)
					.where(
						and(
							inArray(this.table.id, idChunk),
							notExists(client.select({ one: sql`1` }).from(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, this.table.id))),
						),
					)
					.returning({ id: this.table.id });
				deletedCount += deletedRows.length;
			});

			return deletedCount;
		});
	}

	async findMediaFileCleanupData(metadataId: string, tx?: DatabaseTransaction) {
		return await findMediaCleanupData({ where: eq(schema.mediaFiles.metadataId, metadataId), tx });
	}

	async deleteWithMediaFiles({ metadataId, tx }: { metadataId: string; tx: DatabaseTransaction }) {
		await tx.delete(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, metadataId));
		await this.delete({ primaryId: metadataId, tx });
	}

	/**
	 * Get similar/recommended metadata
	 */

	async getMoreLikeThis<F extends string>(args: {
		metadataId: string;
		source?: MoreLikeThisSource | undefined;
		fields?: FieldsConfig<F> | undefined;
		limit: number;
		offset: number;
		tx?: DatabaseTransaction | undefined;
	}): Promise<{ total: number; data: Array<SelectFields<MetadataWithRelation, F>> }> {
		return await getMoreLikeThis({ logger: this.logger, findMany: (p) => this.findMany(p) }, args);
	}

	/**
	 * Find or create metadata from provider result
	 */
	async findOrCreateMetadata({
		type,
		providerName,
		providers,
		results,
		matchScore,
		tx,
	}: {
		type: "movie" | "tv_show";
		providerName: string;
		providers?: ReadonlyArray<{ name: string; externalId: string }> | undefined;
		results: ProviderMetadataResult;
		matchScore?: number | undefined;
		tx?: DatabaseTransaction | undefined;
	}) {
		const links = normalizeProviderLinks(providerName, results.externalId, providers);

		const existingLink = await this.findProvider({ externalId: results.externalId, name: providerName, entityType: type, tx });
		if (existingLink?.metadata) {
			await this.linkProviders(existingLink.metadata.id, type, links, tx);

			return { metadata: existingLink.metadata, created: false };
		}

		const stableKey = createProviderStableKey({ providerName, entityType: type, externalId: results.externalId });

		const metadataWhere = and(
			eq(this.table.title, results.title),
			eq(this.table.type, type),
			eq(this.table.releaseDate, results.releaseDate),
		);
		const [existingByStableKey, candidateByIdentity] = await Promise.all([
			this.selectFirst({ where: eq(this.table.stableKey, stableKey), tx }),
			this.selectFirst({ where: metadataWhere, tx }),
		]);
		const existingMetadata = existingByStableKey ? null : candidateByIdentity;
		const created = !(existingByStableKey ?? existingMetadata);
		const metadataValues = {
			stableKey,
			type,
			...toMetadataValues(results, providerName, matchScore),
		};
		let metadata = existingByStableKey ?? existingMetadata ?? undefined;
		if (metadata) {
			// Never clobber scalar fields the user explicitly locked.
			const locked = new Set(await this.getLockedFields(metadata.id, tx));
			const updateValues: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(metadataValues)) {
				if (!locked.has(key)) updateValues[key] = value;
			}

			const hasUpdates = hasEntry(updateValues);
			if (hasUpdates) {
				const [updated] = await databaseFactory
					.getClient({ tx })
					.update(this.table)
					.set(updateValues)
					.where(eq(this.table.id, metadata.id))
					.returning();
				metadata = updated ?? metadata;
			}
		} else {
			metadata = await this.findOrCreate({ where: metadataWhere, values: metadataValues, tx });
		}

		if (!metadata) throw new NotFoundError("Error while creating metadata");

		const metadataWithStableKey = metadata.stableKey ? metadata : { ...metadata, stableKey };
		const patch: { stableKey?: string; primaryProviderId?: string } = {};
		if (!metadata.stableKey) patch.stableKey = stableKey;

		if (!metadata.primaryProviderId) patch.primaryProviderId = providerName;

		if (hasEntry(patch)) {
			await this.update({ primaryId: metadata.id, values: patch, tx });
		}

		await this.linkProviders(metadata.id, type, links, tx);

		this.logger.info("Metadata linked to providers", {
			metadataId: metadata.id,
			providers: links.map((link) => link.name),
		});

		return { metadata: metadataWithStableKey, created };
	}

	async linkProviders(
		metadataId: string,
		type: "movie" | "tv_show",
		links: ReadonlyArray<{ name: string; externalId: string }>,
		tx?: DatabaseTransaction,
	): Promise<void> {
		if (links.length === 0) return;

		const providers = await providersRepository.upsertByStableKey(
			links.map((link) => ({
				stableKey: createProviderStableKey({ providerName: link.name, entityType: type, externalId: link.externalId }),
				name: link.name,
				entityType: type,
				externalId: link.externalId,
			})),
			tx,
		);

		if (providers.length > 0) {
			await this.insertProviders({
				values: providers.map((provider) => ({ metadataId, providerId: provider.id })),
				tx,
			});
		}
	}
}

export const metadataRepository = new MetadataRepository();
