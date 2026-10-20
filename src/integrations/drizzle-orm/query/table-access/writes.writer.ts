import type { FieldsConfig, SelectFields } from "@reelvault/sdk/common";
import { eq, getTableColumns, inArray, type SQL, sql } from "drizzle-orm";
import type { AnySQLiteInsert, SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTables, DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { applyFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { hasEntry } from "@/utils/array.utils";
import { DomainError } from "@/utils/domain.errors";
import { forEachChunked } from "./chunking.utils";
import { selectFirst } from "./select.builder";
import type { TableAccessBase, TableInsertValue, TableSelect, TableUpdateSet } from "./table-access.types";

export async function findOrCreate<TTable extends DatabaseTables>(
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
	if (!(where || primaryId))
		throw new DomainError("internal", `${repository.tableName}: findOrCreate requires 'primaryId' or 'where'`, {
			code: "table_access.find_or_create_key_missing",
		});

	const hasValues = hasEntry(values);
	if (!hasValues)
		throw new DomainError("internal", `${repository.tableName}: findOrCreate requires 'values'`, {
			code: "table_access.find_or_create_values_missing",
		});

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

export async function insertRows<TTable extends DatabaseTables>(
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

export async function insertRowsReturning<TTable extends DatabaseTables>(
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

/** Columns an `"inserted"` upsert must never copy back: the identity and the original creation time. */
const UPSERT_MANAGED_COLUMNS = new Set(["id", "createdAt"]);

/**
 * Builds the conflict update set from the inserted values: every column present
 * in the insert (except the identity and `createdAt`) takes its `excluded`
 * value, and `updatedAt` is stamped when the table has it.
 */
function insertedUpdateSet<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	valuesArray: Array<TableInsertValue<TTable>>,
): Record<string, SQL | Date> {
	const columns: Record<string, SQLiteColumn> = getTableColumns(repository.table);
	const keys = new Set<string>();
	for (const row of valuesArray) {
		for (const key of Object.keys(row)) keys.add(key);
	}

	const set: Record<string, SQL | Date> = {};
	for (const key of keys) {
		if (UPSERT_MANAGED_COLUMNS.has(key)) continue;

		const column = columns[key];
		if (column) set[key] = sql`excluded.${sql.identifier(column.name)}`;
	}

	if ("updatedAt" in repository.table) set.updatedAt = new Date();

	if (!hasEntry(set))
		throw new DomainError("internal", `${repository.tableName}: upsert has no column to update`, {
			code: "table_access.upsert_set_empty",
		});

	return set;
}

/**
 * Insert-or-update by a unique target. One implementation for every settings,
 * schedule, preference and stable-key write; callers supply only the values,
 * the conflict target and — when not every inserted column may change — the
 * `set` list.
 */
export async function upsertRows<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{
		values,
		target,
		set = "inserted",
		setWhere,
		returning = false,
		tx,
	}: {
		values: TableInsertValue<TTable> | Array<TableInsertValue<TTable>>;
		target: SQLiteColumn | SQLiteColumn[];
		set?: TableUpdateSet<TTable> | "inserted" | undefined;
		setWhere?: SQL | undefined;
		returning?: boolean | undefined;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<Array<TableSelect<TTable>>> {
	const valuesArray = toInsertValuesArray(values);
	if (valuesArray.length === 0) return [];

	const updateSet = set === "inserted" ? insertedUpdateSet(repository, valuesArray) : set;
	const query = databaseFactory.getClient({ tx }).insert(repository.table).values(valuesArray);
	// A generic table is a union of every schema table here, which defeats
	// Drizzle's conflict-set inference. Widening only for the config call keeps
	// the public `set` typed by `TableUpdateSet<TTable>` and `returning()` typed
	// by the concrete insert builder.
	const configurable: AnySQLiteInsert = query;
	configurable.onConflictDoUpdate({ target, set: updateSet, ...(setWhere ? { setWhere } : {}) });

	if (!returning) {
		await Promise.resolve(query);

		return [];
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
		throw new DomainError("internal", `${repository.tableName}: update requires 'primaryId', 'ids' or 'where'`, {
			code: "table_access.update_target_missing",
		});
	}

	if (ids?.length === 0) return undefined;

	if (!hasEntry(values)) return undefined;

	return "updatedAt" in repository.table && !("updatedAt" in values) ? { ...values, updatedAt: new Date() } : values;
}

interface UpdateParams<TTable extends DatabaseTables> {
	primaryId?: string | undefined;
	ids?: string[] | undefined;
	where?: SQL | undefined;
	values: TableUpdateSet<TTable>;
	tx?: DatabaseTransaction | undefined;
}

export function runUpdate<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	params: UpdateParams<TTable>,
	returning: true,
): Promise<Array<TableSelect<TTable>>>;

export function runUpdate<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	params: UpdateParams<TTable>,
	returning?: false,
): Promise<undefined>;

export async function runUpdate<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{ primaryId, ids, where, values, tx }: UpdateParams<TTable>,
	returning = false,
): Promise<Array<TableSelect<TTable>> | undefined> {
	const updateSet = resolveUpdateSet(repository, { primaryId, ids, where, values });
	if (!updateSet) return returning ? [] : undefined;

	const query = databaseFactory
		.getClient({ tx })
		.update(repository.table)
		.set(updateSet)
		.where(whereClauseFor(repository, { primaryId, ids, where }));

	if (!returning) {
		await query;
		return undefined;
	}

	return await query.returning();
}

export async function updateAndReturn<TTable extends DatabaseTables, F extends string>(
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
	const [row] = await runUpdate(repository, { primaryId, values, tx }, true);
	if (!row) return undefined;

	return applyFields(row, fields);
}

interface DeleteParams {
	primaryId?: string | undefined;
	ids?: string[] | undefined;
	where?: SQL | undefined;
	tx?: DatabaseTransaction | undefined;
}

export function runDelete<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	params: DeleteParams,
	returning: true,
): Promise<Array<TableSelect<TTable>>>;

export function runDelete<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	params: DeleteParams,
	returning?: false,
): Promise<undefined>;

export async function runDelete<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{ primaryId, ids, where, tx }: DeleteParams,
	returning = false,
): Promise<Array<TableSelect<TTable>> | undefined> {
	if (!(where || primaryId || ids?.length)) {
		throw new DomainError("internal", `${repository.tableName}: delete requires 'primaryId', 'ids' or 'where'`, {
			code: "table_access.delete_target_missing",
		});
	}

	if (ids?.length === 0) return returning ? [] : undefined;

	const query = databaseFactory.getClient({ tx }).delete(repository.table).where(whereClauseFor(repository, { primaryId, ids, where }));

	if (!returning) {
		await query;
		return undefined;
	}

	return await query.returning();
}

export async function deleteAndReturn<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{
		primaryId,
		tx,
	}: {
		primaryId: string;
		tx?: DatabaseTransaction | undefined;
	},
): Promise<TableSelect<TTable> | undefined> {
	const [row] = await runDelete(repository, { primaryId, tx }, true);

	return row;
}

/** Table-access wrapper around {@link updateManyFieldsById}. */
export async function updateManyFields<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	params: {
		columns: Record<string, SQLiteColumn>;
		updates: ReadonlyArray<{ id: string; values: Record<string, string | number | null | undefined> }>;
		touchUpdatedAt?: boolean | undefined;
	},
): Promise<void> {
	await updateManyFieldsById({
		table: repository.table,
		primaryKeyColumn: repository.primaryKeyColumn,
		...params,
	});
}

/**
 * Chunked `CASE ... WHEN id THEN value ... ELSE column END` update for provider
 * syncs: one statement per chunk assigns per-row values, and rows that omit a
 * field keep their stored value. Replaces one autocommit UPDATE per changed row.
 */
export async function updateManyFieldsById(options: {
	table: SQLiteTable;
	primaryKeyColumn: SQLiteColumn;
	columns: Record<string, SQLiteColumn>;
	updates: ReadonlyArray<{ id: string; values: Record<string, string | number | null | undefined> }>;
	touchUpdatedAt?: boolean | undefined;
}): Promise<void> {
	const rows = options.updates.filter((update) => Object.keys(update.values).length > 0);
	if (rows.length === 0) return;

	const client = databaseFactory.getClient();
	await forEachChunked(rows, async (chunk) => {
		const set: Record<string, SQL | Date> = {};
		if (options.touchUpdatedAt === true) set.updatedAt = new Date();
		for (const [field, column] of Object.entries(options.columns)) {
			const provided = chunk.filter((row) => row.values[field] !== undefined);
			if (provided.length === 0) continue;

			const cases = provided.map((row) => sql`WHEN ${row.id} THEN ${row.values[field]}`);
			set[field] = sql`CASE ${options.primaryKeyColumn} ${sql.join(cases, sql` `)} ELSE ${column} END`;
		}

		await client
			.update(options.table)
			.set(set)
			.where(
				inArray(
					options.primaryKeyColumn,
					chunk.map((row) => row.id),
				),
			);
	});
}
