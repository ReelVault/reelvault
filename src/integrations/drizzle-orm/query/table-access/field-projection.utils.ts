import type { FieldsConfig, SelectFields } from "@reelvault/sdk/common";
import { getTableColumns, type SQL, type Table } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTables, DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { hasEntry, unique } from "@/utils/array.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { applyWindow, selectMany } from "./select.builder";
import type { ProjectedSelectParams, TableAccessBase, TableSelect } from "./table-access.types";

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

function buildProjection(
	repository: { tableName: string; table: Table },
	fieldsKey: string,
	fields: readonly string[],
	required: readonly string[],
): Record<string, SQLiteColumn> {
	const requested = new Set([...fields.filter((field) => !field.includes(".")), ...required]);
	const columns: Record<string, SQLiteColumn> = getTableColumns(repository.table);
	const selection = pickColumns(columns, requested);

	const hasEntries = hasEntry(selection);
	if (!hasEntries) return columns;

	projectionCache.set(fieldsKey, selection);

	return selection;
}

/**
 * Picks the `requested`/`required` columns out of a table's column record.
 * Shared primitive behind the field-projection builders (`buildProjection`,
 * `selectColumns`, `buildRelationProjection`). An empty pick stays empty;
 * callers that fall back to "all columns" handle that themselves.
 */
export function pickColumns(
	columns: Record<string, SQLiteColumn>,
	requested: ReadonlySet<string>,
	required: readonly string[] = [],
): Record<string, SQLiteColumn> {
	const requiredFields = new Set(required);
	const selection: Record<string, SQLiteColumn> = {};
	for (const [name, column] of Object.entries(columns)) {
		if (requiredFields.has(name) || requested.has(name)) selection[name] = column;
	}

	return selection;
}

/**
 * Column sets are picked per request, and the same field list comes back on
 * every request for the same table — so the pick is cached per column set.
 */
const pickedColumnsCache = new WeakMap<object, Map<string, Record<string, SQLiteColumn>>>();

/** {@link pickColumns} with the pick cached per column set and field list. */
export function pickColumnsCached(
	columns: Record<string, SQLiteColumn>,
	requested: ReadonlySet<string>,
	required: readonly string[] = [],
): Record<string, SQLiteColumn> {
	const key = `${[...requested].toSorted().join(",")}|${[...required].toSorted().join(",")}`;
	let cachedByKey = pickedColumnsCache.get(columns);
	if (!cachedByKey) {
		cachedByKey = new Map();
		pickedColumnsCache.set(columns, cachedByKey);
	}

	const cached = cachedByKey.get(key);
	if (cached) return cached;

	const selection = pickColumns(columns, requested, required);
	if (cachedByKey.size < 1000) cachedByKey.set(key, selection);

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
