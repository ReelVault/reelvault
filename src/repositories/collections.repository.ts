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
import { and, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { serverConstants } from "@/config/server/server.constants";
import { systemSettingsStore } from "@/config/system-settings.store";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { createPageResponse } from "@/integrations/drizzle-orm/query/pagination.utils";
import { applyFields, includesField } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { filterLike } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import {
	buildOrderBy,
	buildWhereConditions,
	parseStandardQuery,
	parseWithFilters,
	type QueryMap,
	resolveSortOrder,
} from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { withTiebreaker } from "@/integrations/drizzle-orm/query/parsing/sorting.parser";
import { cachedCount, filterSignature } from "@/integrations/drizzle-orm/query/table-access/row-count.cache";
import {
	defineRepository,
	defineTableAccess,
	parseFieldsForRead,
} from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import type { ProjectedSelectParams } from "@/integrations/drizzle-orm/query/table-access/table-access.types";
import { runInTransaction } from "@/integrations/drizzle-orm/query/transaction.utils";
import { loadNamedRelation } from "@/integrations/drizzle-orm/utils/named-relation.reader";
import { createLocalStableKey } from "@/integrations/drizzle-orm/utils/stable-key.utils";
import { groupBy, toMap, unique } from "@/utils/array.utils";
import {
	countQualifyingCollections,
	findQualifyingCollectionIds,
	findQualifyingCollectionRows,
	type QualifyingPage,
	type QualifyingScope,
} from "./collections/listing.reader";
import { loadMetadataPreviews } from "./collections/previews.reader";
import { metadataRepository } from "./metadata.repository";
import { processNamedEntities, upsertNamedEntities } from "./provider-entity-sync.writer";

const collections = defineTableAccess("collections", {
	primaryKeyColumn: "id",
});
const collectionProviders = defineTableAccess("collectionProviders", {
	primaryKeyColumn: "collectionId",
});

const collectionQueryMap: QueryMap<CollectionFilters, CollectionSorting> = {
	filters: {
		name: (value: string) => filterLike(schema.collections.name, value),
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

const overrides = {
	async findPage<F extends string>(
		query?: PaginationQuery & FieldsQuery<F> & CollectionFilters & CollectionSorting,
	): Promise<PaginatedResponse<SelectFields<CollectionWithRelations, F>>> {
		const { pagination, fields, filters, sorting } = parseWithFilters<F, CollectionFilters, CollectionSorting>(query);
		const where = buildWhereConditions(filters, collectionQueryMap.filters);
		const baseOrderBy = buildOrderBy(sorting, collectionQueryMap.orderBy, collectionQueryMap.defaults);
		// Tiebreaker keeps offset pagination deterministic for non-unique keys.
		let orderBy: typeof baseOrderBy | undefined;
		if (baseOrderBy) {
			orderBy = withTiebreaker(baseOrderBy, collections.table.id, resolveSortOrder(sorting, collectionQueryMap.defaults));
		}
		const minItems = filters?.minItems ?? systemSettingsStore.get("collections.minimalToShow");

		// Page ids come back already ordered/limited from SQL — the previous version
		// loaded EVERY qualifying collection id and passed them all into an `inArray`.
		// Count and page ids share the same grouped subquery and are independent.
		// The count is cached per (filters, minItems) for 10 s — the same staleness
		// contract as every other paginated list — because metadata writes flush the
		// response-body cache and every page would otherwise re-run the group-by.
		const [total, pageRows] = await Promise.all([
			cachedCount("collections", { filters: filterSignature(filters, collectionQueryMap.filters), minItems }, () =>
				countQualifyingCollections({ where, minItems }),
			),
			findQualifyingCollectionRows({
				where,
				minItems,
				orderBy,
				limit: pagination.limit,
				offset: pagination.offset,
			}),
		]);
		if (total === 0) return createPageResponse({ total: 0, pagination, data: [] });
		if (pageRows.length === 0) return createPageResponse({ total, pagination, data: [] });

		// The page query already ordered/limited the rows, so they hydrate directly
		// instead of being re-read by id through findMany (one statement less).
		const data = await hydrateRelations(pageRows, fields);

		return createPageResponse({ total, pagination, data });
	},

	async findByIdForRead<F extends string>(collectionId: string, query?: FieldsQuery<F>) {
		return await getCollectionRepository().findById({ primaryId: collectionId, fields: parseFieldsForRead(query) });
	},

	async findByName(name: string) {
		return await collections.selectFirst({ where: eq(collections.table.name, name) });
	},

	async createAndRead<F extends string>(
		body: CreateCollection,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<CollectionWithRelations, F> | undefined> {
		const { fields } = parseStandardQuery(query);
		const collection = await getCollectionRepository().findOrCreateByName({ name: body.name, values: body });
		if (!collection) return undefined;

		const loadRelations =
			includesField(fields, "providers") || includesField(fields, "metadataCount") || includesField(fields, "posterImages");

		if (loadRelations) {
			return await getCollectionRepository().findById({ primaryId: collection.id, fields });
		}

		return applyFields<CollectionWithRelations, F>(
			{
				...collection,
				providers: [],
				metadataCount: 0,
				posterImages: [],
			},
			fields,
		);
	},

	async updateAndRead<F extends string>(
		collectionId: string,
		body: UpdateCollection,
		query?: FieldsQuery<F>,
	): Promise<SelectFields<CollectionWithRelations, F> | undefined> {
		const { fields } = parseStandardQuery(query);
		const [collection] = await collections.updateReturning({ primaryId: collectionId, values: body });
		if (!collection) return undefined;

		const [hydrated] = await hydrateRelations([collection], fields);

		return hydrated;
	},

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
		const data = await collections.selectMany({ where, orderBy, limit, offset, tx });

		return hydrateRelations(data, fields, tx);
	},

	/** Total collections meeting the `minItems` threshold. */
	async countWithMinimumMetadata(scope: QualifyingScope): Promise<number> {
		return await countQualifyingCollections(scope);
	},

	/** Ordered page of qualifying collection ids. */
	async findPageIdsWithMinimumMetadata(page: QualifyingPage): Promise<string[]> {
		return await findQualifyingCollectionIds(page);
	},

	/** Ordered page of qualifying collection rows. */
	async findPageRowsWithMinimumMetadata(page: QualifyingPage) {
		return await findQualifyingCollectionRows(page);
	},

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
		const collection = await collections.selectFirstById({ primaryId, tx });
		if (!collection) return undefined;

		const [hydrated] = await hydrateRelations([collection], fields, tx);

		return hydrated;
	},

	async findOrCreateByName({ name, values, tx }: { name: string; values: CreateCollection; tx?: DatabaseTransaction }) {
		return await collections.findOrCreate({
			where: eq(collections.table.name, name),
			values: { ...values, stableKey: createLocalStableKey({ namespace: "collection", value: name }) },
			tx,
		});
	},

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
	},

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
			insertEntities: async (items) => await upsertNamedEntities(collections.table, items, tx),
			selectEntities: async (names) => await collections.findByColumnIn(collections.table.name, names, { tx }),
			persistAssociations: async (associations) => {
				const uniqueEntityIds = unique(associations, ({ entityId }) => entityId);
				const nextSortOrders = await nextManualSortOrders(uniqueEntityIds, tx);
				await collectionProviders.insert({
					values: associations.flatMap(({ entityId, providerId }) => (providerId ? [{ collectionId: entityId, providerId }] : [])),
					tx,
				});
				await metadataRepository.insertCollections({
					values: uniqueEntityIds.map((entityId) => ({
						metadataId,
						collectionId: entityId,
						sortOrder: nextSortOrders.get(entityId) ?? 0,
					})),
					tx,
				});
			},
		});
	},
};

export const collectionRepository = defineRepository(collections, overrides);

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getCollectionRepository() {
	return collectionRepository;
}

async function hydrateRelations<F extends string>(
	items: Array<typeof schema.collections.$inferSelect>,
	fields?: FieldsConfig<F>,
	tx?: DatabaseTransaction,
): Promise<Array<SelectFields<CollectionWithRelations, F>>> {
	const ids = items.map((c) => c.id);
	let providersByCollectionId = new Map<string, Array<typeof schema.providers.$inferSelect>>();
	if (includesField(fields, "providers")) providersByCollectionId = await loadProviders(ids, tx);

	const metadataByCollectionId = await loadMetadataPreviews(ids, tx, {
		withCounts: includesField(fields, "metadataCount"),
		withPosters: includesField(fields, "posterImages"),
	});

	return items.map((item) => {
		const meta = metadataByCollectionId.get(item.id);

		return applyFields<CollectionWithRelations, F>(
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

async function nextManualSortOrders(collectionIds: string[], tx?: DatabaseTransaction): Promise<Map<string, number>> {
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

async function loadProviders(
	collectionIds: string[],
	tx?: DatabaseTransaction,
): Promise<Map<string, Array<typeof schema.providers.$inferSelect>>> {
	if (collectionIds.length === 0) return new Map();

	const rows = await loadNamedRelation(databaseFactory.getClient({ tx }), collectionIds, {
		metadataId: schema.collectionProviders.collectionId,
		junctionTable: schema.collectionProviders,
		entityColumn: schema.collectionProviders.providerId,
		entityTable: schema.providers,
		data: getTableColumns(schema.providers),
	});

	return groupBy(
		rows,
		(row) => row.metadataId,
		(row) => row.data,
	);
}
