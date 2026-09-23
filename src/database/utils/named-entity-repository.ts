import type { FieldsQuery, PaginatedResponse, PaginationQuery, SelectFields, SortQuery } from "@reelvault/sdk/common";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { findPageWithQueryMap, type SchemaTable, type TableAccess } from "@/database/table-access";
import type { DatabaseTables, DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { type QueryMap, QueryUtils } from "@/database/utils/query-parser";

export interface NamedEntityRepositoryConfig<
	TTableName extends DatabaseTables,
	TProviderTableName extends DatabaseTables,
	TCreate extends { name: string },
	TFilters extends object,
	TSorting extends SortQuery,
> {
	/** Concrete table object, exposed as `table` for provider-sync upserts. */
	table: SchemaTable[TTableName];
	/** Table access for the entity table. */
	entity: TableAccess<TTableName>;
	/** Table access for the provider junction table — only its `insert` is exposed. */
	providerEntity: TableAccess<TProviderTableName>;
	queryMap: QueryMap<TFilters, TSorting>;
	/**
	 * Find-or-create by name with the entity's local stableKey. Declared in the
	 * repository file because the `where` clause needs the entity's concrete
	 * `name` column, which the generic table name cannot name.
	 */
	findOrCreateByName: (params: {
		name: string;
		values: TCreate;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<SchemaTable[TTableName]["$inferSelect"] | undefined>;
}

/**
 * Shared shape of the named-entity repositories (genres, keywords, companies):
 * full table-access delegation, paginated admin listing, the read-after-write
 * CRUD quartet consumed by DictionaryCrudService, and the find-or-create seam.
 * The provider-sync `process` stays repository-local — its payload type and
 * junction column names are entity-specific.
 */
export function defineNamedEntityRepository<
	TTableName extends DatabaseTables,
	TProviderTableName extends DatabaseTables,
	TCreate extends { name: string },
	TFilters extends object,
	TSorting extends SortQuery,
>(config: NamedEntityRepositoryConfig<TTableName, TProviderTableName, TCreate, TFilters, TSorting>) {
	const { entity, providerEntity } = config;
	type EntityRow = SchemaTable[TTableName]["$inferSelect"];

	return {
		table: config.table,
		primaryKeyColumn: entity.primaryKeyColumn,
		query: entity.query,
		selectMany: entity.selectMany,
		selectFirst: entity.selectFirst,
		findMany: entity.findMany,
		findById: entity.findById,
		findOrCreate: entity.findOrCreate,
		insert: entity.insert,
		update: entity.update,
		count: entity.count,
		isExists: entity.isExists,
		delete: entity.delete,
		insertProviders: providerEntity.insert,

		insertReturning: entity.insertReturning,
		updateReturning: entity.updateReturning,
		updateAndReturn: entity.updateAndReturn,
		deleteReturning: entity.deleteReturning,
		deleteAndReturn: entity.deleteAndReturn,
		findByIds: entity.findByIds,
		findByColumnIn: entity.findByColumnIn,

		findPage: async <F extends string>(
			query?: PaginationQuery & FieldsQuery<F> & TFilters & TSorting,
		): Promise<PaginatedResponse<SelectFields<EntityRow, F>>> => await findPageWithQueryMap(entity, config.queryMap, query),

		findByIdForRead: async <F extends string>(entityId: string, query?: FieldsQuery<F>) => {
			const { fields } = QueryUtils.parseStandard(query);

			return await entity.findById({ primaryId: entityId, fields });
		},

		createAndRead: async <F extends string>(body: TCreate, query?: FieldsQuery<F>): Promise<SelectFields<EntityRow, F> | undefined> => {
			const { fields } = QueryUtils.parseStandard(query);
			const created = await config.findOrCreateByName({ name: body.name, values: body });

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

		findOrCreateByName: config.findOrCreateByName,
	};
}
