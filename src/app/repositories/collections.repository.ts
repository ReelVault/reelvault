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
import { and, eq, inArray, sql } from "drizzle-orm";
import { serverConstants } from "@/config/server/server.constants";
import { systemSettingsStore } from "@/config/system-settings.store";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { QueryPagination } from "@/integrations/drizzle-orm/query/pagination.utils";
import { QueryFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { QueryFiltering } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import { type QueryMap, QueryUtils } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { cachedCount, filterSignature } from "@/integrations/drizzle-orm/query/table-access/row-count.cache";
import { defineTableAccess, parseFieldsForRead } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import type { ProjectedSelectParams } from "@/integrations/drizzle-orm/query/table-access/table-access.types";
import { runInTransaction } from "@/integrations/drizzle-orm/query/transaction.utils";
import { processNamedEntities, upsertNamedEntities } from "@/integrations/drizzle-orm/utils/provider-entity-sync.writer";
import { createLocalStableKey } from "@/integrations/drizzle-orm/utils/stable-key.utils";
import { groupBy, toMap, unique } from "@/utils/array.utils";
import {
	countQualifyingCollections,
	findQualifyingCollectionIds,
	type QualifyingPage,
	type QualifyingScope,
} from "./collections/listing.reader";
import { loadMetadataPreviews } from "./collections/previews.reader";
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

class CollectionsRepository {
	readonly table = schema.collections;
	readonly primaryKeyColumn = collections.primaryKeyColumn;
	readonly query = collections.query;
	readonly selectMany = collections.selectMany;
	readonly selectFirst = collections.selectFirst;
	readonly selectFirstById = collections.selectFirstById;
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
		const minItems = filters?.minItems ?? systemSettingsStore.get("collections.minimalToShow");

		// Page ids come back already ordered/limited from SQL — the previous version
		// loaded EVERY qualifying collection id and passed them all into an `inArray`.
		// Count and page ids share the same grouped subquery and are independent.
		// The count is cached per (filters, minItems) for 10 s — the same staleness
		// contract as every other paginated list — because metadata writes flush the
		// response-body cache and every page would otherwise re-run the group-by.
		const [total, pageIds] = await Promise.all([
			cachedCount("collections", { filters: filterSignature(filters, collectionQueryMap.filters), minItems }, () =>
				this.countWithMinimumMetadata({ where, minItems }),
			),
			this.findPageIdsWithMinimumMetadata({
				where,
				minItems,
				orderBy,
				limit: pagination.limit,
				offset: pagination.offset,
			}),
		]);
		if (total === 0) return QueryPagination.createResponse({ total: 0, pagination, data: [] });
		if (pageIds.length === 0) return QueryPagination.createResponse({ total, pagination, data: [] });

		const data = await this.findMany({
			where: QueryFiltering.combine([where, QueryFiltering.inArray(this.table.id, pageIds)]),
			orderBy,
			fields,
		});

		return QueryPagination.createResponse({ total, pagination, data });
	}

	async findByIdForRead<F extends string>(collectionId: string, query?: FieldsQuery<F>) {
		return await this.findById({ primaryId: collectionId, fields: parseFieldsForRead(query) });
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
			loadMetadataPreviews(ids, tx, {
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

	/** Total collections meeting the `minItems` threshold. */
	async countWithMinimumMetadata(scope: QualifyingScope): Promise<number> {
		return await countQualifyingCollections(scope);
	}

	/** Ordered page of qualifying collection ids. */
	async findPageIdsWithMinimumMetadata(page: QualifyingPage): Promise<string[]> {
		return await findQualifyingCollectionIds(page);
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
		const collection = await this.selectFirstById({ primaryId, tx });
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

		await runInTransaction(tx, async (targetTx) => {
			const client = databaseFactory.getClient({ tx: targetTx });
			// Chunk the update: a large manually-ordered collection can exceed SQLite's
			// bound-variable limit (both the CASE list and the inArray).
			for (let start = 0; start < metadataIds.length; start += serverConstants.database.queryChunkSize) {
				const idChunk = metadataIds.slice(start, start + serverConstants.database.queryChunkSize);
				const sqlCases = idChunk.map((id, index) => sql`WHEN ${schema.metadataCollections.metadataId} = ${id} THEN ${start + index}`);
				await client
					.update(schema.metadataCollections)
					.set({
						sortOrder: sql`CASE ${sql.join(sqlCases, sql` `)} ELSE ${schema.metadataCollections.sortOrder} END`,
					})
					.where(and(eq(schema.metadataCollections.collectionId, collectionId), inArray(schema.metadataCollections.metadataId, idChunk)));
			}
		});
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
		await processNamedEntities({
			items: providerCollections,
			providerName,
			entityType: "collection",
			entityLabel: "collections",
			tx,
			context: { metadataId },
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
}

export const collectionRepository = new CollectionsRepository();
