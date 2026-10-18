import type { FieldsConfig, FieldsQuery } from "@reelvault/sdk/common";
import { getTableColumns } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTables } from "@/integrations/drizzle-orm/database.types";
import { QueryFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { DomainError } from "@/utils/domain.errors";
import { selectFirstByIdPrepared } from "./by-id.reader";
import { countRows, findByColumnIn, findById, findByIds, findManyRows, isExists } from "./reads.reader";
import { selectFirst, selectMany, tableQuery } from "./select.builder";
import type { RepositoryDelegations, TableAccess, TableAccessBase, TableAccessConfig } from "./table-access.types";
import { deleteAndReturn, findOrCreate, insertRows, insertRowsReturning, runDelete, runUpdate, updateAndReturn } from "./writes.writer";

export function defineTableAccess<TTable extends DatabaseTables>(
	tableName: TTable,
	config: TableAccessConfig<TTable>,
): TableAccess<TTable> {
	const table = schema[tableName];
	const columns: Record<string, SQLiteColumn> = getTableColumns(table);
	const primaryKeyColumn = columns[config.primaryKeyColumn];
	if (!primaryKeyColumn) {
		throw new DomainError("internal", `${tableName}: primary key column "${config.primaryKeyColumn}" was not found in the table columns`, {
			code: "table_access.primary_key_missing",
		});
	}

	const repository: TableAccessBase<TTable> = {
		tableName,
		table,
		primaryKeyColumn,
	};

	// One prepared statement per table (and per connection): the default-projection
	// id lookup that hydrating repositories run behind every findByPrimaryId.
	return {
		...repository,
		query: (tx) => tableQuery(repository, tx),
		selectMany: (params) => selectMany(repository, params),
		selectFirst: (params) => selectFirst(repository, params),
		selectFirstById: (params) => selectFirstByIdPrepared<TTable>(repository, params),
		findMany: (params) => findManyRows(repository, params),
		findById: (params) => findById(repository, params),
		findByIds: (params) => findByIds(repository, params),
		findByColumnIn: (column, values, params) => findByColumnIn(repository, column, values, params),
		findOrCreate: (params) => findOrCreate(repository, params),
		insert: (params) => insertRows(repository, params),
		insertReturning: (params) => insertRowsReturning(repository, params),
		update: (params) => runUpdate(repository, params),
		updateReturning: (params) => runUpdate(repository, params, true),
		updateAndReturn: (params) => updateAndReturn(repository, params),
		delete: (params) => runDelete(repository, params),
		deleteReturning: (params) => runDelete(repository, params, true),
		deleteAndReturn: (params) => deleteAndReturn(repository, params),
		count: (params) => countRows(repository, params),
		isExists: (params) => isExists(repository, params),
	};
}

/**
 * Merges a table-access object's generic delegations with repository-specific
 * methods. Overrides are applied after the spread, so a repository's own
 * hydrating `findById`/`findByPrimaryId`/`findMany` always wins over the
 * table-access twin — delegating a read to that twin silently drops relations
 * (see AGENTS.md).
 */
export function defineRepository<TTable extends DatabaseTables, TOverrides extends object>(
	access: TableAccess<TTable>,
	overrides: TOverrides,
): Omit<RepositoryDelegations<TTable>, keyof TOverrides> & TOverrides {
	const delegations: RepositoryDelegations<TTable> = {
		table: access.table,
		primaryKeyColumn: access.primaryKeyColumn,
		query: access.query,
		selectMany: access.selectMany,
		selectFirst: access.selectFirst,
		selectFirstById: access.selectFirstById,
		findMany: access.findMany,
		findById: access.findById,
		findOrCreate: access.findOrCreate,
		insert: access.insert,
		update: access.update,
		count: access.count,
		isExists: access.isExists,
		delete: access.delete,
		insertReturning: access.insertReturning,
		updateReturning: access.updateReturning,
		updateAndReturn: access.updateAndReturn,
		deleteReturning: access.deleteReturning,
		deleteAndReturn: access.deleteAndReturn,
		findByIds: access.findByIds,
		findByColumnIn: access.findByColumnIn,
	};

	return { ...delegations, ...overrides };
}

/**
 * Parses the standard `fields` query for a repository read-by-id path. Use it
 * in `findByIdForRead` and hand the result to the repository's own hydrating
 * `findById`/`findByPrimaryId` — never to the table-access `findById` twin,
 * which returns the flat row and silently drops relations.
 */
export function parseFieldsForRead<F extends string>(query?: FieldsQuery<F>): FieldsConfig<F> {
	return QueryFields.parse({ fields: query?.fields });
}
