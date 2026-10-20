import type { FieldsConfig, FieldsQuery, PaginatedResponse, PaginationQuery, SelectFields, SortQuery } from "@reelvault/sdk/common";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTables, DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { createPageResponse } from "@/integrations/drizzle-orm/query/pagination.utils";
import { applyFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import {
	buildOrderBy,
	buildWhereConditions,
	parseWithFilters,
	type QueryMap,
	resolveSortOrder,
} from "@/integrations/drizzle-orm/query/parsing/query.parser";
import { withTiebreaker } from "@/integrations/drizzle-orm/query/parsing/sorting.parser";
import { unique } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import { isNotNullish } from "@/utils/type.utils";
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
	const { pagination, fields, sorting, filters } = parseWithFilters<F, TFilters, TSorting>(query);
	const where = buildWhereConditions(filters, queryMap.filters);
	const baseOrderBy = buildOrderBy(sorting, queryMap.orderBy, queryMap.defaults);
	// Append the primary key as a tiebreaker: most sort keys are non-unique
	// (title/createdAt at second resolution), so equal keys would otherwise make
	// offset pagination return overlapping/skipped rows.
	let orderBy: typeof baseOrderBy | undefined;
	if (baseOrderBy) {
		orderBy = withTiebreaker(baseOrderBy, access.primaryKeyColumn, resolveSortOrder(sorting, queryMap.defaults));
	}
	const pageParams = { where, orderBy, fields, limit: pagination.limit, offset: pagination.offset };
	const countPromise = cachedCount(access.tableName, filterSignature(filters, queryMap.filters), () => access.count({ where }));
	const [total, data] = await Promise.all([countPromise, findMany(pageParams)]);

	return createPageResponse({ total, pagination, data });
}

export async function findById<TTable extends DatabaseTables, F extends string>(
	repository: TableAccessBase<TTable>,
	{ primaryId, fields, tx }: { primaryId: string; fields?: FieldsConfig<F> | undefined; tx?: DatabaseTransaction | undefined },
): Promise<SelectFields<TableSelect<TTable>, F> | undefined> {
	const row = await selectFirstWithFields(repository, { where: eq(repository.primaryKeyColumn, primaryId), tx, fields });
	if (!row) return undefined;

	return applyFields(row, fields);
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

/**
 * Which of `ids` exist in the table — one chunked read for bulk prechecks.
 * Duplicates are dropped first, so the result set never depends on input order.
 */
export async function findExistingIds<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	ids: readonly string[],
	{ column = repository.primaryKeyColumn, tx }: { column?: SQLiteColumn | undefined; tx?: DatabaseTransaction | undefined } = {},
): Promise<Set<string>> {
	const uniqueIds = unique(ids.filter(Boolean));
	if (uniqueIds.length === 0) return new Set();

	const rows = await mapChunked(uniqueIds, (idChunk) =>
		databaseFactory.getClient({ tx }).select({ id: column }).from(repository.table).where(inArray(column, idChunk)),
	);

	return new Set(rows.map((row) => String(row.id)));
}

export interface OffsetPageParams<TRow> {
	/** Only the identity fields are needed: the table name keys the count cache and the key column breaks ties. */
	access: { tableName: string; primaryKeyColumn: SQLiteColumn };
	where?: SQL | undefined;
	orderBy: SQL;
	limit: number;
	offset: number;
	findMany: (page: { where?: SQL | undefined; orderBy: SQL; limit: number; offset: number }) => PromiseLike<TRow[]>;
	count: () => Promise<number>;
	/** Opts into the shared 10 s count cache; omit for an exact total. */
	countKey?: unknown;
	/** Direction of the appended primary-key tiebreaker; defaults to the usual newest-first lists. */
	tiebreakerOrder?: "asc" | "desc" | undefined;
}

/**
 * One offset page plus its total, with the primary key appended as a
 * tiebreaker. Callers pass their own loader and count so repositories that
 * project columns or map rows keep doing so, while the pagination contract
 * (parallel count, stable ordering) lives in one place.
 */
export async function findOffsetPage<TRow>({
	access,
	where,
	orderBy,
	limit,
	offset,
	findMany,
	count,
	countKey,
	tiebreakerOrder = "desc",
}: OffsetPageParams<TRow>): Promise<{ data: TRow[]; total: number }> {
	const ordered = withTiebreaker(orderBy, access.primaryKeyColumn, tiebreakerOrder);
	const countPromise = countKey === undefined ? count() : cachedCount(access.tableName, countKey, count);
	const [total, data] = await Promise.all([countPromise, findMany({ where, orderBy: ordered, limit, offset })]);

	return { data, total };
}

/**
 * Aggregate counters for dashboard cards: one `COUNT(*)`, one `SUM` and named
 * `COUNT(CASE WHEN <filter> THEN 1 END)` metrics in a single scan.
 */
export async function countAggregates<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{
		total = "total",
		sum,
		counts,
		tx,
	}: {
		total?: string | false | undefined;
		sum?: { key: string; column: SQLiteColumn } | undefined;
		counts?: Record<string, SQL | undefined> | undefined;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<Record<string, number>> {
	const selection: Record<string, SQL<number>> = {};
	if (total !== false) selection[total] = sql<number>`count(*)`;
	if (sum) selection[sum.key] = sql<number>`coalesce(sum(${sum.column}), 0)`;

	for (const [key, filter] of Object.entries(counts ?? {})) {
		selection[key] = filter ? sql<number>`count(case when ${filter} then 1 end)` : sql<number>`count(*)`;
	}

	const [row] = await databaseFactory.getClient({ tx }).select(selection).from(repository.table);

	return row ?? {};
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
