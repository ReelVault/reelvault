import type {
	CollectionFilters,
	CollectionSorting,
	CollectionWithRelations,
	CreateCollection,
	FieldsConfig,
	FieldsQuery,
	PaginatedResponse,
	PaginationQuery,
	SelectFields,
	UpdateCollection,
} from "@reelvault/sdk/common";
import type { ProviderResultCollection } from "@reelvault/sdk/plugin";
import { and, count, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { ProjectedSelectParams } from "@/database/table-access";
import { defineTableAccess } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryFiltering } from "@/database/utils/filtering";
import { QueryPagination } from "@/database/utils/pagination";
import { type QueryMap, QueryUtils } from "@/database/utils/query-parser";
import { createLocalStableKey } from "@/database/utils/stable-key";
import { serverConfig } from "@/server.config";
import { groupBy, toMap, unique } from "@/utils/array.utils";
import { createLogger } from "@/utils/logger";
import { syncNamedProviderEntities, upsertNamedEntities } from "../utils/provider-entity-sync";
import { metadataRepository } from "./metadata.repository";

const collections = defineTableAccess("collections", {
	primaryKeyColumn: "id",
});
const collectionProviders = defineTableAccess("collectionProviders", {
	primaryKeyColumn: "collectionId",
});

const collectionQueryMap: QueryMap<CollectionFilters, CollectionSorting> = {
	filters: {
		name: (value: string) => QueryFiltering.like(schema.collections.name, value),
		minItems: () => {
			/* intentionally empty */
		},
	},
	orderBy: {
		name: schema.collections.name,
		createdAt: schema.collections.createdAt,
		updatedAt: schema.collections.updatedAt,
	},
	defaults: { sortBy: "name", sortOrder: "asc" },
};

interface PosterImage {
	imageId: string;
	updatedAt: Date;
}

class CollectionsRepository {
	private readonly logger = createLogger(this.constructor.name);
	readonly table = schema.collections;
	readonly primaryKeyColumn = collections.primaryKeyColumn;
	readonly query = collections.query;
	readonly selectMany = collections.selectMany;
	readonly selectFirst = collections.selectFirst;
	readonly findOrCreate = collections.findOrCreate;
	readonly insert = collections.insert;
	readonly update = collections.update;
	readonly count = collections.count;
	readonly isExists = collections.isExists;
	readonly delete = collections.delete;
	readonly insertReturning = collections.insertReturning;
	readonly updateReturning = collections.updateReturning;
	readonly updateAndReturn = collections.updateAndReturn;
	readonly deleteReturning = collections.deleteReturning;
	readonly deleteAndReturn = collections.deleteAndReturn;
	readonly findByIds = collections.findByIds;
	readonly findByColumnIn = collections.findByColumnIn;
	readonly insertProviders = collectionProviders.insert;

	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & CollectionFilters & CollectionSorting,
	): Promise<PaginatedResponse<SelectFields<CollectionWithRelations, F>>> {
		const { pagination, fields, filters, sorting } = QueryUtils.parseWithFilters<F, CollectionFilters, CollectionSorting>(query);
		const where = QueryUtils.buildWhereConditions(filters, collectionQueryMap.filters);
		const baseOrderBy = QueryUtils.buildOrderBy(sorting, collectionQueryMap.orderBy, collectionQueryMap.defaults);
		// Tiebreaker keeps offset pagination deterministic for non-unique keys.
		const orderBy = baseOrderBy ? sql`${baseOrderBy}, ${this.table.id}` : undefined;
		const minItems = filters?.minItems ?? serverConfig.collections.minimalToShow;

		// Page ids come back already ordered/limited from SQL — the previous version
		// loaded EVERY qualifying collection id and passed them all into an `inArray`.
		const total = await this.countWithMinimumMetadata({ where, minItems });
		if (total === 0) return QueryPagination.createResponse({ total: 0, pagination, data: [] });

		const pageIds = await this.findPageIdsWithMinimumMetadata({
			where,
			minItems,
			orderBy,
			limit: pagination.limit,
			offset: pagination.offset,
		});
		if (pageIds.length === 0) return QueryPagination.createResponse({ total, pagination, data: [] });

		const data = await this.findMany({
			where: QueryFiltering.combine([where, QueryFiltering.inArray(this.table.id, pageIds)]),
			orderBy,
			fields,
		});

		return QueryPagination.createResponse({ total, pagination, data });
	}

	async findByIdForRead<F extends string>(collectionId: string, query?: FieldsQuery<F>) {
		const { fields } = QueryUtils.parseStandard(query);

		return await this.findById({ primaryId: collectionId, fields });
	}

	async findByName(name: string) {
		return await this.selectFirst({ where: eq(this.table.name, name) });
	}

	async createAndRead<F extends string>(
		body: CreateCollection,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<CollectionWithRelations, F> | undefined> {
		const { fields } = QueryUtils.parseStandard(query);
		const collection = await this.findOrCreateByName({ name: body.name, values: body });
		if (!collection) return undefined;

		const loadRelations =
			QueryFields.includes(fields, "providers") ||
			QueryFields.includes(fields, "metadataCount") ||
			QueryFields.includes(fields, "posterImages");

		return loadRelations
			? await this.findById({ primaryId: collection.id, fields })
			: QueryFields.apply<CollectionWithRelations, F>(
					{
						...collection,
						providers: [],
						metadataCount: 0,
						posterImages: [],
					},
					fields,
				);
	}

	async updateAndRead<F extends string>(
		collectionId: string,
		body: UpdateCollection,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<CollectionWithRelations, F> | undefined> {
		const { fields } = QueryUtils.parseStandard(query);
		const [collection] = await this.updateReturning({ primaryId: collectionId, values: body });
		if (!collection) return undefined;

		const [hydrated] = await this.hydrateRelations([collection], fields);

		return hydrated;
	}

	private async hydrateRelations<F extends string>(
		items: Array<typeof schema.collections.$inferSelect>,
		fields?: FieldsConfig<F>,
		tx?: DatabaseTransaction,
	): Promise<Array<SelectFields<CollectionWithRelations, F>>> {
		const ids = items.map((c) => c.id);
		const [providersByCollectionId, metadataByCollectionId] = await Promise.all([
			QueryFields.includes(fields, "providers")
				? this.loadProviders(ids, tx)
				: new Map<string, Array<typeof schema.providers.$inferSelect>>(),
			this.loadMetadataPreviews(ids, tx, {
				withCounts: QueryFields.includes(fields, "metadataCount"),
				withPosters: QueryFields.includes(fields, "posterImages"),
			}),
		]);

		return items.map((item) => {
			const meta = metadataByCollectionId.get(item.id);

			return QueryFields.apply<CollectionWithRelations, F>(
				{
					...item,
					providers: providersByCollectionId.get(item.id) ?? [],
					metadataCount: meta?.count ?? 0,
					posterImages: meta?.posterImages ?? [],
				},
				fields,
			);
		});
	}

	/**
	 * Get all collections with pagination
	 */
	async findMany<F extends string>({
		fields,
		where,
		orderBy,
		limit,
		offset,
		tx,
	}: ProjectedSelectParams<F>): Promise<Array<SelectFields<CollectionWithRelations, F>>> {
		const data = await this.selectMany({ where, orderBy, limit, offset, tx });

		return this.hydrateRelations(data, fields, tx);
	}

	/** Collections whose metadata-item count meets `minItems` (grouped, filtered). */
	private qualifyingCollections({
		where,
		minItems,
		tx,
	}: {
		where?: SQL | undefined;
		minItems: number;
		tx?: DatabaseTransaction | undefined;
	}) {
		const metadataItemCount = count(schema.metadataCollections.metadataId);

		return databaseFactory
			.getClient({ tx })
			.select({ id: this.table.id })
			.from(this.table)
			.innerJoin(schema.metadataCollections, eq(schema.metadataCollections.collectionId, this.table.id))
			.where(where)
			.groupBy(this.table.id)
			.having(gte(metadataItemCount, minItems));
	}

	/** Total collections meeting the `minItems` threshold, computed in SQL (no id materialization). */
	async countWithMinimumMetadata({
		where,
		minItems,
		tx,
	}: {
		where?: SQL | undefined;
		minItems: number;
		tx?: DatabaseTransaction | undefined;
	}): Promise<number> {
		const subquery = this.qualifyingCollections({ where, minItems, tx }).as("qualifying_collections");
		const [row] = await databaseFactory.getClient({ tx }).select({ value: count() }).from(subquery);

		return row?.value ?? 0;
	}

	/** Ordered page of qualifying collection ids — pushes LIMIT/OFFSET into SQL. */
	async findPageIdsWithMinimumMetadata({
		where,
		minItems,
		orderBy,
		limit,
		offset,
		tx,
	}: {
		where?: SQL | undefined;
		minItems: number;
		orderBy?: SQL | undefined;
		limit: number;
		offset: number;
		tx?: DatabaseTransaction | undefined;
	}): Promise<string[]> {
		const base = this.qualifyingCollections({ where, minItems, tx });
		const ordered = orderBy ? base.orderBy(orderBy) : base;
		const rows = await ordered.limit(limit).offset(offset);

		return rows.map((row) => row.id);
	}

	/**
	 * Get a single collection by ID
	 */
	async findById<F extends string>({
		primaryId,
		fields,
		tx,
	}: {
		primaryId: string;
		fields: FieldsConfig<F>;
		tx?: DatabaseTransaction | undefined;
	}): Promise<SelectFields<CollectionWithRelations, F> | undefined> {
		const collection = await this.selectFirst({ where: eq(this.primaryKeyColumn, primaryId), tx });
		if (!collection) return undefined;

		const [hydrated] = await this.hydrateRelations([collection], fields, tx);

		return hydrated;
	}

	async findOrCreateByName({ name, values, tx }: { name: string; values: CreateCollection; tx?: DatabaseTransaction }) {
		return await this.findOrCreate({
			where: eq(this.table.name, name),
			values: { ...values, stableKey: createLocalStableKey({ namespace: "collection", value: name }) },
			tx,
		});
	}

	/**
	 * Persist a manually configured ordering of metadata items within a collection.
	 */
	async updateManualOrder({ collectionId, metadataIds, tx }: { collectionId: string; metadataIds: string[]; tx?: DatabaseTransaction }) {
		if (metadataIds.length === 0) return;

		const runner = async (targetTx: DatabaseTransaction) => {
			const client = databaseFactory.getClient({ tx: targetTx });
			// Chunk the update: a large manually-ordered collection can exceed SQLite's
			// bound-variable limit (both the CASE list and the inArray).
			for (let start = 0; start < metadataIds.length; start += serverConfig.database.queryChunkSize) {
				const idChunk = metadataIds.slice(start, start + serverConfig.database.queryChunkSize);
				const sqlCases = idChunk.map((id, index) => sql`WHEN ${schema.metadataCollections.metadataId} = ${id} THEN ${start + index}`);
				await client
					.update(schema.metadataCollections)
					.set({
						sortOrder: sql`CASE ${sql.join(sqlCases, sql` `)} ELSE ${schema.metadataCollections.sortOrder} END`,
					})
					.where(and(eq(schema.metadataCollections.collectionId, collectionId), inArray(schema.metadataCollections.metadataId, idChunk)));
			}
		};
		if (tx) {
			await runner(tx);
		} else {
			await databaseFactory.transaction(runner);
		}
	}

	/**
	 * Process collection for metadata (link metadata to collection)
	 */
	async process({
		metadataId,
		providerName,
		collections: providerCollections,
		tx,
	}: {
		metadataId: string;
		providerName: string;
		collections?: ProviderResultCollection[] | undefined;
		tx?: DatabaseTransaction | undefined;
	}) {
		if (!providerCollections?.length) {
			this.logger.debug("No collections to process", { metadataId });

			return;
		}

		try {
			await syncNamedProviderEntities({
				items: providerCollections,
				providerName,
				entityType: "collection",
				tx,
				insertEntities: async (items) => await upsertNamedEntities(this.table, items, tx),
				selectEntities: async (names) => await this.findByColumnIn(this.table.name, names, { tx }),
				persistAssociations: async (associations) => {
					const uniqueEntityIds = unique(associations, ({ entityId }) => entityId);
					const nextSortOrders = await this.nextManualSortOrders(uniqueEntityIds, tx);
					await Promise.all([
						this.insertProviders({
							values: associations.flatMap(({ entityId, providerId }) => (providerId ? [{ collectionId: entityId, providerId }] : [])),
							tx,
						}),
						metadataRepository.insertCollections({
							values: uniqueEntityIds.map((entityId) => ({
								metadataId,
								collectionId: entityId,
								sortOrder: nextSortOrders.get(entityId) ?? 0,
							})),
							tx,
						}),
					]);
				},
			});
		} catch (error) {
			this.logger.error("Failed to process collection", error, { metadataId });
			throw error;
		}
	}

	private async nextManualSortOrders(collectionIds: string[], tx?: DatabaseTransaction): Promise<Map<string, number>> {
		if (collectionIds.length === 0) return new Map();

		const client = databaseFactory.getClient({ tx });
		const rows = await client
			.select({
				collectionId: schema.metadataCollections.collectionId,
				maxSortOrder: sql<number>`MAX(${schema.metadataCollections.sortOrder})`,
			})
			.from(schema.metadataCollections)
			.where(inArray(schema.metadataCollections.collectionId, collectionIds))
			.groupBy(schema.metadataCollections.collectionId);

		return toMap(
			rows,
			(row) => row.collectionId,
			(row) => row.maxSortOrder + 1,
		);
	}

	private async loadProviders(
		collectionIds: string[],
		tx?: DatabaseTransaction,
	): Promise<Map<string, Array<typeof schema.providers.$inferSelect>>> {
		if (collectionIds.length === 0) return new Map();

		const rows = await databaseFactory
			.getClient({ tx })
			.select({ collectionId: schema.collectionProviders.collectionId, provider: schema.providers })
			.from(schema.collectionProviders)
			.innerJoin(schema.providers, eq(schema.providers.id, schema.collectionProviders.providerId))
			.where(inArray(schema.collectionProviders.collectionId, collectionIds));

		return groupBy(
			rows,
			(row) => row.collectionId,
			(row) => row.provider,
		);
	}

	private async loadMetadataPreviews(
		collectionIds: string[],
		tx?: DatabaseTransaction,
		options?: { withCounts?: boolean; withPosters?: boolean },
	) {
		const withCounts = options?.withCounts ?? true;
		const withPosters = options?.withPosters ?? true;
		if (collectionIds.length === 0) return new Map<string, { count: number; posterImages: PosterImage[] }>();

		if (!(withCounts || withPosters)) return new Map<string, { count: number; posterImages: PosterImage[] }>();

		const client = databaseFactory.getClient({ tx });
		const rankedPosters = client
			.select({
				collectionId: schema.metadataCollections.collectionId,
				posterId: schema.metadataImages.imageId,
				posterUpdatedAt: schema.images.updatedAt,
				rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${schema.metadataCollections.collectionId} ORDER BY MIN(${schema.metadataCollections.sortOrder}) ASC, ${schema.metadataImages.imageId} ASC)`.as(
					"rn",
				),
			})
			.from(schema.metadataCollections)
			.innerJoin(
				schema.metadataImages,
				and(eq(schema.metadataImages.metadataId, schema.metadataCollections.metadataId), eq(schema.metadataImages.imageType, "poster")),
			)
			.innerJoin(schema.images, eq(schema.images.id, schema.metadataImages.imageId))
			.where(inArray(schema.metadataCollections.collectionId, collectionIds))
			.groupBy(schema.metadataCollections.collectionId, schema.metadataImages.imageId)
			.as("ranked_posters");

		const [counts, posters] = await Promise.all([
			withCounts
				? client
						.select({
							collectionId: schema.metadataCollections.collectionId,
							count: sql<number>`COUNT(DISTINCT ${schema.metadataCollections.metadataId})`,
						})
						.from(schema.metadataCollections)
						.where(inArray(schema.metadataCollections.collectionId, collectionIds))
						.groupBy(schema.metadataCollections.collectionId)
				: [],
			withPosters
				? client
						.select({
							collectionId: rankedPosters.collectionId,
							posterId: rankedPosters.posterId,
							posterUpdatedAt: rankedPosters.posterUpdatedAt,
						})
						.from(rankedPosters)
						.where(lte(rankedPosters.rn, 4))
				: [],
		]);

		const countMap = toMap(
			counts,
			(c) => c.collectionId,
			(c) => c.count,
		);
		const posterMap = new Map<string, PosterImage[]>();
		for (const row of posters) {
			const existing = posterMap.get(row.collectionId) ?? [];
			if (existing.length < 4) {
				existing.push({ imageId: row.posterId, updatedAt: row.posterUpdatedAt });
				posterMap.set(row.collectionId, existing);
			}
		}

		const result = new Map<string, { count: number; posterImages: PosterImage[] }>();
		for (const id of collectionIds) {
			result.set(id, {
				count: countMap.get(id) ?? 0,
				posterImages: posterMap.get(id) ?? [],
			});
		}

		return result;
	}
}

export const collectionRepository = new CollectionsRepository();
