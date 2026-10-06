import type { FieldsQuery, PaginatedResponse, PaginationQuery, ProviderEntityType, SelectFields, SortQuery } from "@reelvault/sdk/common";
import { eq, inArray } from "drizzle-orm";
import type { SQLiteColumn, SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/database/database";
import {
	defineRepository,
	findPageWithQueryMap,
	parseFieldsForRead,
	type SchemaTable,
	type TableAccess,
	type TableSelect,
} from "@/database/table-access";
import type { DatabaseTables, DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { type QueryMap, QueryUtils } from "@/database/utils/query-parser";
import { createLocalStableKey } from "@/database/utils/stable-key";
import { unique } from "@/utils/array.utils";
import { type NamedProviderEntity, processNamedEntities, upsertNamedEntities } from "./provider-entity-sync";

/** Named-entity tables this factory supports — a union lets the internal inserts/selects resolve their column shapes. */
type NamedEntityTableName = "genres" | "keywords" | "companies";

export interface NamedEntityRepositoryConfig<
	TTableName extends NamedEntityTableName,
	TProviderTableName extends DatabaseTables,
	TFilters extends object,
	TSorting extends SortQuery,
> {
	/** Concrete table object, exposed as `table` for provider-sync upserts. */
	table: SchemaTable[NamedEntityTableName] & { name: SQLiteColumn };
	/** Table access for the entity table. */
	entity: TableAccess<TTableName>;
	/** Table access for the provider junction table — only its `insert` is exposed. */
	providerEntity: TableAccess<TProviderTableName>;
	/** The entity's `name` column — the generic table name cannot name it. */
	nameColumn: SQLiteColumn;
	/** Local stable-key namespace for the entity name. */
	namespace: string;
	/** Provider-sync discriminator and log label. */
	entityType: ProviderEntityType;
	entityLabel: string;
	/** Provider junction insert — the FK column (genreId/keywordId/companyId) is entity-specific. */
	insertProviderLinks: (links: Array<{ entityId: string; providerId: string }>, tx?: DatabaseTransaction) => Promise<void>;
	/** metadata ↔ entity link insert — the FK column is entity-specific. */
	insertMetadataLinks: (params: { metadataId: string; entityIds: string[]; tx?: DatabaseTransaction | undefined }) => Promise<void>;
	queryMap: QueryMap<TFilters, TSorting>;
}

/**
 * Shared shape of the named-entity repositories (genres, keywords, companies):
 * full table-access delegation, paginated admin listing, the read-after-write
 * CRUD quartet consumed by DictionaryCrudService, the find-or-create seam and
 * the provider-sync `process`. The entity-specific schema table, name column,
 * stable-key namespace and junction-link inserts come in through the config.
 */
export function defineNamedEntityRepository<
	TTableName extends NamedEntityTableName,
	TProviderTableName extends DatabaseTables,
	TFilters extends object,
	TSorting extends SortQuery,
>(config: NamedEntityRepositoryConfig<TTableName, TProviderTableName, TFilters, TSorting>) {
	const { entity, providerEntity, nameColumn } = config;
	type EntityRow = TableSelect<TTableName>;

	const findOrCreateByName = async ({
		name,
		values,
		tx,
	}: {
		name: string;
		values: { name: string };
		tx?: DatabaseTransaction | undefined;
	}): Promise<EntityRow | undefined> => {
		const client = databaseFactory.getClient({ tx });
		const [created] = await client
			.insert(config.table)
			.values({ ...values, stableKey: createLocalStableKey({ namespace: config.namespace, value: name }) })
			.onConflictDoNothing()
			.returning();
		if (created) return created;

		const [existing] = await client.select().from(config.table).where(eq(nameColumn, name)).limit(1);

		return existing;
	};

	return defineRepository(entity, {
		insertProviders: providerEntity.insert,

		findPage: async <F extends string>(
			query?: PaginationQuery & FieldsQuery<F> & TFilters & TSorting,
		): Promise<PaginatedResponse<SelectFields<EntityRow, F>>> => await findPageWithQueryMap(entity, config.queryMap, query),

		findByIdForRead: async <F extends string>(entityId: string, query?: FieldsQuery<F>) =>
			await entity.findById({ primaryId: entityId, fields: parseFieldsForRead(query) }),

		createAndRead: async <F extends string>(
			body: { name: string },
			query?: FieldsQuery<F>,
		): Promise<SelectFields<EntityRow, F> | undefined> => {
			const { fields } = QueryUtils.parseStandard(query);
			const created = await findOrCreateByName({ name: body.name, values: body });

			return created ? QueryFields.apply<EntityRow, F>(created, fields) : undefined;
		},

		updateAndRead: async <F extends string>(
			entityId: string,
			body: SQLiteUpdateSetSource<SchemaTable[TTableName]>,
			query?: FieldsQuery<F>,
		): Promise<SelectFields<EntityRow, F> | undefined> => {
			const { fields } = QueryUtils.parseStandard(query);

			return await entity.updateAndReturn({ primaryId: entityId, values: body, fields });
		},

		findOrCreateByName,

		process: async ({
			metadataId,
			providerName,
			items,
			tx,
		}: {
			metadataId: string;
			providerName: string;
			items: NamedProviderEntity[] | undefined;
			tx?: DatabaseTransaction | undefined;
		}): Promise<void> => {
			await processNamedEntities({
				items,
				providerName,
				entityType: config.entityType,
				entityLabel: config.entityLabel,
				tx,
				insertEntities: async (entities) => await upsertNamedEntities(config.table, entities, tx),
				selectEntities: async (names) =>
					await databaseFactory
						.getClient({ tx })
						.select({ id: config.table.id, stableKey: config.table.stableKey, name: config.table.name })
						.from(config.table)
						.where(inArray(nameColumn, names)),
				persistAssociations: async (associations) => {
					const uniqueEntityIds = unique(associations, ({ entityId }) => entityId);
					await Promise.all([
						config.insertProviderLinks(
							associations.flatMap(({ entityId, providerId }) => (providerId ? [{ entityId, providerId }] : [])),
							tx,
						),
						config.insertMetadataLinks({ metadataId, entityIds: uniqueEntityIds, tx }),
					]);
				},
			});
		},
	});
}
