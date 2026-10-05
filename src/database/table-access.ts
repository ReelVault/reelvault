import type { FieldsConfig, FieldsQuery, PaginatedResponse, PaginationQuery, SelectFields, SortQuery } from "@reelvault/sdk/common";
import { and, eq, getTableColumns, inArray, type SQL, sql, type Table } from "drizzle-orm";
import type { SQLiteColumn, SQLiteInsertValue, SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTables, DatabaseTransaction, DatabaseType } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";
import { QueryPagination } from "@/database/utils/pagination";
import { type QueryMap, QueryUtils } from "@/database/utils/query-parser";
import { serverConstants } from "@/server.constants";
import { chunk, hasEntry, isNotNullish, unique } from "@/utils/array.utils";
import { MemoryCache } from "@/utils/memory-cache";
import { PromiseUtils } from "@/utils/promise.utils";
import { isRecord } from "@/utils/type.utils";

// Paginated lists re-run the same COUNT every page. The count scan (often with
// a correlated EXISTS per row) is serialized onto the same connection as the
// page query, so it lands directly in page latency. A short TTL keeps totals
// accurate enough for pagination UIs while removing the scan from pages 2+.
// Approved contract change (2026-09): totals may be up to 10 s stale.
const countCache = new MemoryCache<number>({ ttlMs: 10_000, maxSize: 500, name: "db.count" });

function countCacheKey(tableName: string, filters: unknown): string {
	// Raw string key — micro-benchmarked ~7x faster than bunHash->hex on this
	// hot path (scripts/benchmarks/micro.ts); Map keys need no normalization.
	return `${tableName}:${JSON.stringify(filters ?? null)}`;
}

/**
 * Extracts only the filter values declared in the query map. The parsed
 * `filters` value is the raw request query, so hashing it directly folded
 * `page`/`limit`/`sortBy`/`fields` into the COUNT cache key and made every page
 * a cache miss.
 */
export function filterSignature(filters: unknown, filterMap: Record<string, unknown>): Array<[string, unknown]> {
	if (!isRecord(filters)) return [];

	return Object.keys(filterMap)
		.map((key): [string, unknown] => [key, filters[key]])
		.filter(([, value]) => isNotNullish(value));
}

/**
 * COUNT for paginated lists with a 10 s per-filter cache (see countCache).
 * Uses getOrSet to deduplicate concurrent identical count queries.
 */
export async function cachedCount(tableName: string, filters: unknown, runCount: () => Promise<number>): Promise<number> {
	const key = countCacheKey(tableName, filters);

	return await countCache.getOrSet(key, runCount);
}

/**
 * Runs `fn` over id/value lists chunked by `queryChunkSize` so one statement
 * cannot exceed SQLite's per-statement variable limit. Lists within the chunk
 * size run as a single call; oversized lists run one query per chunk —
 * sequentially by default (cross-chunk ordering is the caller's concern), or
 * concurrently when `concurrency` is given. Results are flattened in order.
 */
export async function mapChunked<T, R>(
	items: readonly T[],
	fn: (chunkItems: T[]) => Promise<R[]>,
	options?: { concurrency?: number | undefined },
): Promise<R[]> {
	if (items.length === 0) return [];

	if (items.length <= serverConstants.database.queryChunkSize) return await fn([...items]);

	const chunks = chunk([...items], serverConstants.database.queryChunkSize);
	if (options?.concurrency !== undefined) {
		return (await PromiseUtils.mapConcurrent(chunks, options.concurrency, fn)).flat();
	}

	const results: R[] = [];
	for (const chunkItems of chunks) {
		results.push(...(await fn(chunkItems)));
	}

	return results;
}

/** Same chunking contract as mapChunked for loops that only await a side effect (bulk INSERTs, deletes). */
export async function forEachChunked<T>(
	items: readonly T[],
	fn: (chunkItems: T[]) => Promise<unknown>,
	options?: { concurrency?: number | undefined },
): Promise<void> {
	if (items.length === 0) return;

	if (items.length <= serverConstants.database.queryChunkSize) {
		await fn([...items]);

		return;
	}

	const chunks = chunk([...items], serverConstants.database.queryChunkSize);
	if (options?.concurrency !== undefined) {
		await PromiseUtils.mapConcurrent(chunks, options.concurrency, fn);

		return;
	}

	for (const chunkItems of chunks) {
		await fn(chunkItems);
	}
}

export type SchemaTable = typeof schema;

export type TableSelect<TTable extends DatabaseTables> = SchemaTable[TTable]["$inferSelect"];

/** Drizzle's own accepted shape for insert values on a generic schema table. */
export type TableInsertValue<TTable extends DatabaseTables> = SQLiteInsertValue<SchemaTable[TTable]>;
/** Drizzle's own accepted shape for update sets on a generic schema table. */
type TableUpdateSet<TTable extends DatabaseTables> = SQLiteUpdateSetSource<SchemaTable[TTable]>;

export interface SelectManyParams {
	where?: SQL | undefined;
	orderBy?: SQL | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
	tx?: DatabaseTransaction | undefined;
}

export type ProjectedSelectParams<F extends string> = SelectManyParams & {
	fields?: FieldsConfig<F> | undefined;
	required?: readonly string[] | undefined;
};

export interface TableAccessConfig<TTable extends DatabaseTables> {
	primaryKeyColumn: keyof SchemaTable[TTable] & string;
}

/** Core identity fields every table-access helper operates on. */
export interface TableAccessBase<TTable extends DatabaseTables> {
	tableName: TTable;
	table: SchemaTable[TTable];
	primaryKeyColumn: SQLiteColumn;
}

export interface TableAccess<TTable extends DatabaseTables> extends TableAccessBase<TTable> {
	query: (tx?: DatabaseTransaction) => DatabaseType["query"][TTable];
	selectMany: (params?: SelectManyParams) => Promise<Array<TableSelect<TTable>>>;
	selectFirst: (params?: { where?: SQL | undefined; tx?: DatabaseTransaction | undefined }) => Promise<TableSelect<TTable> | undefined>;
	/**
	 * `selectMany` + field projection in one call. Use this instead of
	 * hand-rolling `.select().from().where().orderBy().limit().offset()` in a
	 * repository — that pattern has already produced the same "empty orderBy"
	 * bug twice. Repositories that need to merge related data should still
	 * call `selectMany` directly and apply `QueryFields.apply` after merging.
	 */
	findMany: <F extends string>(
		params?: SelectManyParams & { fields?: FieldsConfig<F> | undefined },
	) => Promise<Array<SelectFields<TableSelect<TTable>, F>>>;
	findById: <F extends string>(params: {
		primaryId: string;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<SelectFields<TableSelect<TTable>, F> | undefined>;
	findOrCreate: (params: {
		primaryId?: string | undefined;
		where?: SQL | undefined;
		values: TableInsertValue<TTable>;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<TableSelect<TTable> | undefined>;
	insert: (params: {
		values: TableInsertValue<TTable> | Array<TableInsertValue<TTable>>;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<void>;
	insertReturning: (params: {
		values: TableInsertValue<TTable> | Array<TableInsertValue<TTable>>;
		onConflict?: "doNothing" | "none" | undefined;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<Array<TableSelect<TTable>>>;
	update: (params: {
		primaryId?: string | undefined;
		ids?: string[] | undefined;
		where?: SQL | undefined;
		values: TableUpdateSet<TTable>;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<void>;
	updateReturning: (params: {
		primaryId?: string | undefined;
		ids?: string[] | undefined;
		where?: SQL | undefined;
		values: TableUpdateSet<TTable>;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<Array<TableSelect<TTable>>>;
	updateAndReturn: <F extends string>(params: {
		primaryId: string;
		values: TableUpdateSet<TTable>;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<SelectFields<TableSelect<TTable>, F> | undefined>;
	delete: (params: {
		primaryId?: string | undefined;
		ids?: string[] | undefined;
		where?: SQL | undefined;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<void>;
	deleteReturning: (params: {
		primaryId?: string | undefined;
		ids?: string[] | undefined;
		where?: SQL | undefined;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<Array<TableSelect<TTable>>>;
	deleteAndReturn: (params: { primaryId: string; tx?: DatabaseTransaction | undefined }) => Promise<TableSelect<TTable> | undefined>;
	findByIds: <F extends string>(params: {
		ids: readonly string[];
		fields?: FieldsConfig<F> | undefined;
		orderBy?: SQL | undefined;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<Array<SelectFields<TableSelect<TTable>, F>>>;
	findByColumnIn: <F extends string>(
		column: SQLiteColumn,
		values: ReadonlyArray<string | number>,
		params?: SelectManyParams & { fields?: FieldsConfig<F> | undefined },
	) => Promise<Array<SelectFields<TableSelect<TTable>, F>>>;
	count: (params?: { primaryId?: string | undefined; where?: SQL | undefined; tx?: DatabaseTransaction | undefined }) => Promise<number>;
	isExists: (params: { primaryId?: string | undefined; where?: SQL | undefined; tx?: DatabaseTransaction | undefined }) => Promise<boolean>;
}

export function defineTableAccess<TTable extends DatabaseTables>(
	tableName: TTable,
	config: TableAccessConfig<TTable>,
): TableAccess<TTable> {
	const table = schema[tableName];
	const columns: Record<string, SQLiteColumn> = getTableColumns(table);
	const primaryKeyColumn = columns[config.primaryKeyColumn];
	if (!primaryKeyColumn) {
		throw new Error(`${tableName}: primary key column "${config.primaryKeyColumn}" was not found in the table columns`);
	}

	const repository: TableAccessBase<TTable> = {
		tableName,
		table,
		primaryKeyColumn,
	};

	return {
		...repository,
		query: (tx) => tableQuery(repository, tx),
		selectMany: (params) => selectMany(repository, params),
		selectFirst: (params) => selectFirst(repository, params),
		findMany: (params) => findManyRows(repository, params),
		findById: (params) => findById(repository, params),
		findByIds: (params) => findByIds(repository, params),
		findByColumnIn: (column, values, params) => findByColumnIn(repository, column, values, params),
		findOrCreate: (params) => findOrCreate(repository, params),
		insert: (params) => insertRows(repository, params),
		insertReturning: (params) => insertRowsReturning(repository, params),
		update: (params) => updateRows(repository, params),
		updateReturning: (params) => updateRowsReturning(repository, params),
		updateAndReturn: (params) => updateAndReturn(repository, params),
		delete: (params) => deleteRows(repository, params),
		deleteReturning: (params) => deleteRowsReturning(repository, params),
		deleteAndReturn: (params) => deleteAndReturn(repository, params),
		count: (params) => countRows(repository, params),
		isExists: (params) => isExists(repository, params),
	};
}

export async function findPageWithQueryMap<
	TTable extends DatabaseTables,
	TFilters extends object,
	TSorting extends SortQuery,
	F extends string,
>(
	access: TableAccess<TTable>,
	queryMap: QueryMap<TFilters, TSorting>,
	query?: PaginationQuery & FieldsQuery<F> & TFilters & TSorting,
): Promise<PaginatedResponse<SelectFields<TableSelect<TTable>, F>>>;

export async function findPageWithQueryMap<
	TTable extends DatabaseTables,
	TFilters extends object,
	TSorting extends SortQuery,
	F extends string,
	TRow,
>(
	access: TableAccess<TTable>,
	queryMap: QueryMap<TFilters, TSorting>,
	query: (PaginationQuery & FieldsQuery<F> & TFilters & TSorting) | undefined,
	/**
	 * Repositories whose `findMany` loads relations (or applies other row
	 * enrichment) pass it here so pagination shares one implementation; when
	 * omitted the table-access `findMany` is used directly.
	 */
	findMany: (params: {
		where?: SQL | undefined;
		orderBy?: SQL | undefined;
		fields?: FieldsConfig<F> | undefined;
		limit?: number | undefined;
		offset?: number | undefined;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<TRow[]>,
): Promise<PaginatedResponse<TRow>>;

export async function findPageWithQueryMap<
	TTable extends DatabaseTables,
	TFilters extends object,
	TSorting extends SortQuery,
	F extends string,
	TRow,
>(
	access: TableAccess<TTable>,
	queryMap: QueryMap<TFilters, TSorting>,
	query: (PaginationQuery & FieldsQuery<F> & TFilters & TSorting) | undefined,
	findMany?: (params: {
		where?: SQL | undefined;
		orderBy?: SQL | undefined;
		fields?: FieldsConfig<F> | undefined;
		limit?: number | undefined;
		offset?: number | undefined;
		tx?: DatabaseTransaction | undefined;
	}) => Promise<TRow[]>,
): Promise<PaginatedResponse<TRow> | PaginatedResponse<SelectFields<TableSelect<TTable>, F>>> {
	const { pagination, fields, sorting, filters } = QueryUtils.parseWithFilters<F, TFilters, TSorting>(query);
	const where = QueryUtils.buildWhereConditions(filters, queryMap.filters);
	const baseOrderBy = QueryUtils.buildOrderBy(sorting, queryMap.orderBy, queryMap.defaults);
	// Append the primary key as a tiebreaker: most sort keys are non-unique
	// (title/createdAt at second resolution), so equal keys would otherwise make
	// offset pagination return overlapping/skipped rows.
	const orderBy = baseOrderBy ? sql`${baseOrderBy}, ${access.primaryKeyColumn}` : undefined;
	const pageParams = { where, orderBy, fields, limit: pagination.limit, offset: pagination.offset };
	const countPromise = cachedCount(access.tableName, filterSignature(filters, queryMap.filters), () => access.count({ where }));

	if (findMany) {
		const [total, data] = await Promise.all([countPromise, findMany(pageParams)]);

		return QueryPagination.createResponse({ total, pagination, data });
	}

	const [total, data] = await Promise.all([countPromise, access.findMany<F>(pageParams)]);

	return QueryPagination.createResponse({ total, pagination, data });
}

function tableQuery<TTable extends DatabaseTables>(repository: TableAccessBase<TTable>, tx?: DatabaseTransaction) {
	return databaseFactory.getClient({ tx }).query[repository.tableName];
}

async function findById<TTable extends DatabaseTables, F extends string>(
	repository: TableAccessBase<TTable>,
	{ primaryId, fields, tx }: { primaryId: string; fields?: FieldsConfig<F> | undefined; tx?: DatabaseTransaction | undefined },
): Promise<SelectFields<TableSelect<TTable>, F> | undefined> {
	const row = await selectFirstWithFields(repository, { where: eq(repository.primaryKeyColumn, primaryId), tx, fields });
	if (!row) return undefined;

	return QueryFields.apply(row, fields);
}

async function findByIds<TTable extends DatabaseTables, F extends string>(
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

async function findByColumnIn<TTable extends DatabaseTables, F extends string>(
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

async function selectMany<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	params?: SelectManyParams,
): Promise<Array<TableSelect<TTable>>>;

async function selectMany<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{ where, orderBy, limit, offset, tx }: SelectManyParams = {},
): Promise<unknown[]> {
	const baseQuery = databaseFactory.getClient({ tx }).select().from(repository.table).where(where).$dynamic();

	return await applyWindow(baseQuery, { orderBy, limit, offset });
}

async function selectFirst<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	params: { where?: SQL | undefined; tx?: DatabaseTransaction | undefined } = {},
): Promise<TableSelect<TTable> | undefined> {
	const [row] = await selectMany(repository, { ...params, limit: 1 });

	return row;
}

const projectionCache = new MemoryCache<Record<string, SQLiteColumn>>({ ttlMs: -1, maxSize: 1000, name: "projection" });

export function selectManyWithFields<TTable extends DatabaseTables, F extends string>(
	repository: TableAccessBase<TTable>,
	params: ProjectedSelectParams<F>,
): Promise<Array<SelectFields<TableSelect<TTable>, F>>>;

export async function selectManyWithFields<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	params: ProjectedSelectParams<string>,
): Promise<unknown[]> {
	const { fields, required = [], ...rest } = params;
	if (!fields?.fields.length) return await selectMany(repository, rest);

	const fieldsKey = `${repository.tableName}|${unique(fields.fields).toSorted().join(",")}|${unique(required).toSorted().join(",")}`;
	const selection = projectionCache.get(fieldsKey) ?? buildProjection(repository, fieldsKey, fields.fields, required);

	const client = databaseFactory.getClient({ tx: rest.tx });
	const baseQuery = client.select(selection).from(repository.table).where(rest.where).$dynamic();

	return await applyWindow(baseQuery, rest);
}

/** Minimal chain surface shared by the dynamic select builders used below. */
interface WindowedQuery<TQuery> extends PromiseLike<unknown[]> {
	orderBy(orderBy: SQL): TQuery;
	limit(limit: number): TQuery;
	offset(offset: number): TQuery;
}

/** Shared ORDER BY / LIMIT / OFFSET window for `selectMany` and `selectManyWithFields`. */
async function applyWindow<TQuery extends WindowedQuery<TQuery>>(
	query: TQuery,
	{ orderBy, limit, offset }: Pick<SelectManyParams, "orderBy" | "limit" | "offset">,
): Promise<unknown[]> {
	let result = orderBy ? query.orderBy(orderBy) : query;
	if (limit !== undefined) result = result.limit(limit);

	if (offset !== undefined && offset > 0) result = result.offset(offset);

	return await result;
}

function buildProjection(
	repository: { tableName: string; table: Table },
	fieldsKey: string,
	fields: readonly string[],
	required: readonly string[],
): Record<string, SQLiteColumn> {
	const requested = new Set([...fields.filter((field) => !field.includes(".")), ...required]);
	const columns = getTableColumns(repository.table);
	const selection: Record<string, SQLiteColumn> = {};
	for (const [name, column] of Object.entries(columns)) {
		if (requested.has(name)) selection[name] = column;
	}

	const hasEntries = hasEntry(selection);
	if (!hasEntries) return columns;

	projectionCache.set(fieldsKey, selection);

	return selection;
}

export async function selectFirstWithFields<TTable extends DatabaseTables, F extends string>(
	repository: TableAccessBase<TTable>,
	params: {
		where?: SQL | undefined;
		tx?: DatabaseTransaction | undefined;
		fields?: FieldsConfig<F> | undefined;
		required?: readonly string[] | undefined;
	} = {},
): Promise<SelectFields<TableSelect<TTable>, F> | undefined> {
	return (await selectManyWithFields(repository, { ...params, limit: 1 }))[0];
}

async function findManyRows<TTable extends DatabaseTables, F extends string>(
	repository: TableAccessBase<TTable>,
	{ fields, ...params }: SelectManyParams & { fields?: FieldsConfig<F> | undefined } = {},
): Promise<Array<SelectFields<TableSelect<TTable>, F>>> {
	return await selectManyWithFields(repository, { fields, ...params });
}

async function findOrCreate<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{
		primaryId,
		where,
		values,
		tx,
	}: {
		primaryId?: string | undefined;
		where?: SQL | undefined;
		values: TableInsertValue<TTable>;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<TableSelect<TTable> | undefined> {
	if (!(where || primaryId)) throw new Error(`${repository.tableName}: findOrCreate requires 'primaryId' or 'where'`);

	const hasValues = hasEntry(values);
	if (!hasValues) throw new Error(`${repository.tableName}: findOrCreate requires 'values'`);

	const whereClause = primaryId ? eq(repository.primaryKeyColumn, primaryId) : where;
	const [created] = await databaseFactory.getClient({ tx }).insert(repository.table).values(values).onConflictDoNothing().returning();

	if (created) return created;

	return selectFirst(repository, { where: whereClause, tx });
}

/** Normalizes a single insert value or list to an array; empty/falsy lists become `[]`. */
function toInsertValuesArray<TTable extends DatabaseTables>(
	values: TableInsertValue<TTable> | Array<TableInsertValue<TTable>>,
): Array<TableInsertValue<TTable>> {
	const valuesArray = Array.isArray(values) ? values : [values];
	if (valuesArray.length === 0 || !valuesArray[0]) return [];

	return valuesArray;
}

async function insertRows<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{
		values,
		tx,
	}: {
		values: TableInsertValue<TTable> | Array<TableInsertValue<TTable>>;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<void> {
	const valuesArray = toInsertValuesArray(values);
	if (valuesArray.length === 0) return;

	// Generic insert is intentionally idempotent: `onConflictDoNothing` lets the
	// repositories that use it (watchlist add, subtitle upsert, audit records,
	// better-auth profile creation) retry without duplicate-key failures. A caller
	// that needs a hard conflict error must use Drizzle directly instead.
	await databaseFactory.getClient({ tx }).insert(repository.table).values(valuesArray).onConflictDoNothing();
}

async function insertRowsReturning<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{
		values,
		onConflict = "none",
		tx,
	}: {
		values: TableInsertValue<TTable> | Array<TableInsertValue<TTable>>;
		onConflict?: "doNothing" | "none" | undefined;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<Array<TableSelect<TTable>>> {
	const valuesArray = toInsertValuesArray(values);
	if (valuesArray.length === 0) return [];

	const client = databaseFactory.getClient({ tx });
	const query = client.insert(repository.table).values(valuesArray);
	if (onConflict === "doNothing") {
		return await query.onConflictDoNothing().returning();
	}

	return await query.returning();
}

/** Resolves the WHERE clause from the primary id, an id list, or a raw SQL condition (first match wins). */
function whereClauseFor<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{ primaryId, ids, where }: { primaryId?: string | undefined; ids?: string[] | undefined; where?: SQL | undefined },
): SQL | undefined {
	if (primaryId) return eq(repository.primaryKeyColumn, primaryId);

	if (ids?.length) return inArray(repository.primaryKeyColumn, ids);

	return where;
}

/**
 * Validates the update target, drops no-op updates (empty id list or values)
 * and stamps `updatedAt` when the table has the column and the caller did not
 * set it. Returns `undefined` when there is nothing to update.
 */
function resolveUpdateSet<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{
		primaryId,
		ids,
		where,
		values,
	}: {
		primaryId?: string | undefined;
		ids?: string[] | undefined;
		where?: SQL | undefined;
		values: TableUpdateSet<TTable>;
	},
): TableUpdateSet<TTable> | undefined {
	if (!(where || primaryId || ids?.length)) {
		throw new Error(`${repository.tableName}: update requires 'primaryId', 'ids' or 'where'`);
	}

	if (ids?.length === 0) return undefined;

	if (!hasEntry(values)) return undefined;

	return "updatedAt" in repository.table && !("updatedAt" in values) ? { ...values, updatedAt: new Date() } : values;
}

async function updateRows<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{
		primaryId,
		ids,
		where,
		values,
		tx,
	}: {
		primaryId?: string | undefined;
		ids?: string[] | undefined;
		where?: SQL | undefined;
		values: TableUpdateSet<TTable>;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<void> {
	const updateSet = resolveUpdateSet(repository, { primaryId, ids, where, values });
	if (!updateSet) return;

	await databaseFactory
		.getClient({ tx })
		.update(repository.table)
		.set(updateSet)
		.where(whereClauseFor(repository, { primaryId, ids, where }));
}

async function updateRowsReturning<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{
		primaryId,
		ids,
		where,
		values,
		tx,
	}: {
		primaryId?: string | undefined;
		ids?: string[] | undefined;
		where?: SQL | undefined;
		values: TableUpdateSet<TTable>;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<Array<TableSelect<TTable>>> {
	const updateSet = resolveUpdateSet(repository, { primaryId, ids, where, values });
	if (!updateSet) return [];

	return await databaseFactory
		.getClient({ tx })
		.update(repository.table)
		.set(updateSet)
		.where(whereClauseFor(repository, { primaryId, ids, where }))
		.returning();
}

async function updateAndReturn<TTable extends DatabaseTables, F extends string>(
	repository: TableAccessBase<TTable>,
	{
		primaryId,
		values,
		fields,
		tx,
	}: {
		primaryId: string;
		values: TableUpdateSet<TTable>;
		fields?: FieldsConfig<F> | undefined;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<SelectFields<TableSelect<TTable>, F> | undefined> {
	const [row] = await updateRowsReturning(repository, { primaryId, values, tx });
	if (!row) return undefined;

	return QueryFields.apply(row, fields);
}

async function deleteRows<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{
		primaryId,
		ids,
		where,
		tx,
	}: {
		primaryId?: string | undefined;
		ids?: string[] | undefined;
		where?: SQL | undefined;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<void> {
	if (!(where || primaryId || ids?.length)) {
		throw new Error(`${repository.tableName}: delete requires 'primaryId', 'ids' or 'where'`);
	}

	if (ids?.length === 0) return;

	await databaseFactory.getClient({ tx }).delete(repository.table).where(whereClauseFor(repository, { primaryId, ids, where }));
}

async function deleteRowsReturning<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{
		primaryId,
		ids,
		where,
		tx,
	}: {
		primaryId?: string | undefined;
		ids?: string[] | undefined;
		where?: SQL | undefined;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<Array<TableSelect<TTable>>> {
	if (!(where || primaryId || ids?.length)) {
		throw new Error(`${repository.tableName}: delete requires 'primaryId', 'ids' or 'where'`);
	}

	if (ids?.length === 0) return [];

	return await databaseFactory
		.getClient({ tx })
		.delete(repository.table)
		.where(whereClauseFor(repository, { primaryId, ids, where }))
		.returning();
}

async function deleteAndReturn<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{
		primaryId,
		tx,
	}: {
		primaryId: string;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<TableSelect<TTable> | undefined> {
	const [row] = await deleteRowsReturning(repository, { primaryId, tx });

	return row;
}

async function countRows<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{ primaryId, where, tx }: { primaryId?: string | undefined; where?: SQL | undefined; tx?: DatabaseTransaction | undefined } = {},
): Promise<number> {
	const whereClause = primaryId ? eq(repository.primaryKeyColumn, primaryId) : where;

	return await databaseFactory.getClient({ tx }).$count(repository.table, whereClause);
}

async function isExists<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{ primaryId, where, tx }: { primaryId?: string | undefined; where?: SQL | undefined; tx?: DatabaseTransaction | undefined },
): Promise<boolean> {
	if (!(where || primaryId)) throw new Error(`${repository.tableName}: isExists requires 'primaryId' or 'where'`);

	const whereClause = primaryId ? eq(repository.primaryKeyColumn, primaryId) : where;
	const [result] = await databaseFactory
		.getClient({ tx })
		.select({ exists: sql<number>`1` })
		.from(repository.table)
		.where(whereClause)
		.limit(1);

	return result?.exists === 1;
}
