import type { FieldsConfig, SelectFields } from "@reelvault/sdk/common";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteInsertValue, SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTables, DatabaseTransaction, DatabaseType } from "@/integrations/drizzle-orm/database.types";

export type SchemaTable = typeof schema;

export type TableSelect<TTable extends DatabaseTables> = SchemaTable[TTable]["$inferSelect"];

/** Drizzle's own accepted shape for insert values on a generic schema table. */
export type TableInsertValue<TTable extends DatabaseTables> = SQLiteInsertValue<SchemaTable[TTable]>;

/** Drizzle's own accepted shape for update sets on a generic schema table. */
export type TableUpdateSet<TTable extends DatabaseTables> = SQLiteUpdateSetSource<SchemaTable[TTable]>;

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
	/** Prepared single-row read by primary key — the default-projection fast path for id lookups. */
	selectFirstById: (params: { primaryId: string; tx?: DatabaseTransaction | undefined }) => Promise<TableSelect<TTable> | undefined>;
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

/** Table-access surface a repository exposes — the internal `tableName` discriminator stays private. */
export type RepositoryDelegations<TTable extends DatabaseTables> = Omit<TableAccess<TTable>, "tableName">;
