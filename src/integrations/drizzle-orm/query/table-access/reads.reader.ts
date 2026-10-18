import type { FieldsConfig, FieldsQuery, PaginatedResponse, PaginationQuery, SelectFields, SortQuery } from "@reelvault/sdk/common";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTables, DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { QueryPagination } from "@/integrations/drizzle-orm/query/pagination.utils";
import { QueryFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { type QueryMap, QueryUtils } from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { isNotNullish, unique } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import { mapChunked } from "./chunking.utils";
import { selectFirstWithFields, selectManyWithFields } from "./field-projection.utils";
import { cachedCount, filterSignature } from "./row-count.cache";
import type { SelectManyParams, TableAccess, TableAccessBase, TableSelect } from "./table-access.types";

type FindManyPageFn<F extends string, TRow> = (params: {
	where?: SQL | undefined;
	orderBy?: SQL | undefined;
	fields?: FieldsConfig<F> | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
	tx?: DatabaseTransaction | undefined;
}) => Promise<TRow[]>;

/**
 * Paginated list over a table access with a caller-supplied page loader.
 * Repositories whose `findMany` loads relations (or applies other row
 * enrichment) pass it here so pagination shares one implementation; plain
 * reads pass the table-access `findMany` itself. `findMany` is required so the
 * page row type is inferred from the loader — the previous overload pair
 * duplicated the generic list and could not express the relation-loading
 * variant in one signature.
 */
export async function findPageWithQueryMap<
	TTable extends DatabaseTables,
	TFilters extends object,
	TSorting extends SortQuery,
	F extends string,
	TRow,
>({
	access,
	queryMap,
	query,
	findMany,
}: {
	access: TableAccess<TTable>;
	queryMap: QueryMap<TFilters, TSorting>;
	query?: (PaginationQuery & FieldsQuery<F> & TFilters & TSorting) | undefined;
	findMany: FindManyPageFn<F, TRow>;
}): Promise<PaginatedResponse<TRow>> {
	const { pagination, fields, sorting, filters } = QueryUtils.parseWithFilters<F, TFilters, TSorting>(query);
	const where = QueryUtils.buildWhereConditions(filters, queryMap.filters);
	const baseOrderBy = QueryUtils.buildOrderBy(sorting, queryMap.orderBy, queryMap.defaults);
	// Append the primary key as a tiebreaker: most sort keys are non-unique
	// (title/createdAt at second resolution), so equal keys would otherwise make
	// offset pagination return overlapping/skipped rows.
	const orderBy = baseOrderBy ? sql`${baseOrderBy}, ${access.primaryKeyColumn}` : undefined;
	const pageParams = { where, orderBy, fields, limit: pagination.limit, offset: pagination.offset };
	const countPromise = cachedCount(access.tableName, filterSignature(filters, queryMap.filters), () => access.count({ where }));
	const [total, data] = await Promise.all([countPromise, findMany(pageParams)]);

	return QueryPagination.createResponse({ total, pagination, data });
}

export async function findById<TTable extends DatabaseTables, F extends string>(
	repository: TableAccessBase<TTable>,
	{ primaryId, fields, tx }: { primaryId: string; fields?: FieldsConfig<F> | undefined; tx?: DatabaseTransaction | undefined },
): Promise<SelectFields<TableSelect<TTable>, F> | undefined> {
	const row = await selectFirstWithFields(repository, { where: eq(repository.primaryKeyColumn, primaryId), tx, fields });
	if (!row) return undefined;

	return QueryFields.apply(row, fields);
}

export async function findByIds<TTable extends DatabaseTables, F extends string>(
	repository: TableAccessBase<TTable>,
	{
		ids,
		fields,
		orderBy,
		tx,
	}: {
		ids: readonly string[];
		fields?: FieldsConfig<F> | undefined;
		orderBy?: SQL | undefined;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<Array<SelectFields<TableSelect<TTable>, F>>> {
	const uniqueIds = unique(ids.filter(Boolean));
	if (uniqueIds.length === 0) return [];

	// SQLite binds one parameter per id — chunk oversized id lists so one call
	// cannot exceed the per-statement variable limit. Cross-chunk ORDER BY is
	// only preserved within each chunk; only oversized lists take this path.
	return await mapChunked(uniqueIds, (idChunk) =>
		findManyRows(repository, {
			where: inArray(repository.primaryKeyColumn, idChunk),
			orderBy,
			fields,
			tx,
		}),
	);
}

export async function findByColumnIn<TTable extends DatabaseTables, F extends string>(
	repository: TableAccessBase<TTable>,
	column: SQLiteColumn,
	values: ReadonlyArray<string | number>,
	params?: SelectManyParams & { fields?: FieldsConfig<F> | undefined },
): Promise<Array<SelectFields<TableSelect<TTable>, F>>> {
	const uniqueValues = unique(values.filter((value) => isNotNullish(value)));
	if (uniqueValues.length === 0) return [];

	// Same variable-limit chunking as findByIds — cross-chunk ORDER BY holds
	// only within a chunk; only oversized lists take the multi-query path.
	return await mapChunked(uniqueValues, (valueChunk) => {
		const where = params?.where ? and(inArray(column, valueChunk), params.where) : inArray(column, valueChunk);

		return findManyRows(repository, { ...params, where });
	});
}

export async function findManyRows<TTable extends DatabaseTables, F extends string>(
	repository: TableAccessBase<TTable>,
	{ fields, ...params }: SelectManyParams & { fields?: FieldsConfig<F> | undefined } = {},
): Promise<Array<SelectFields<TableSelect<TTable>, F>>> {
	return await selectManyWithFields(repository, { fields, ...params });
}

export async function countRows<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{ primaryId, where, tx }: { primaryId?: string | undefined; where?: SQL | undefined; tx?: DatabaseTransaction | undefined } = {},
): Promise<number> {
	const whereClause = primaryId ? eq(repository.primaryKeyColumn, primaryId) : where;

	return await databaseFactory.getClient({ tx }).$count(repository.table, whereClause);
}

export async function isExists<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{ primaryId, where, tx }: { primaryId?: string | undefined; where?: SQL | undefined; tx?: DatabaseTransaction | undefined },
): Promise<boolean> {
	if (!(where || primaryId))
		throw new DomainError("internal", `${repository.tableName}: isExists requires 'primaryId' or 'where'`, {
			code: "table_access.lookup_key_missing",
		});

	const whereClause = primaryId ? eq(repository.primaryKeyColumn, primaryId) : where;
	const [result] = await databaseFactory
		.getClient({ tx })
		.select({ exists: sql<number>`1` })
		.from(repository.table)
		.where(whereClause)
		.limit(1);

	return result?.exists === 1;
}
