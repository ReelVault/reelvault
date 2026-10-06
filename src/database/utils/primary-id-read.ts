import type { FieldsConfig, SelectFields } from "@reelvault/sdk/common";
import { eq, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { selectFirstWithFields, type TableAccessBase, type TableSelect } from "@/database/table-access";
import type { DatabaseTables, DatabaseTransaction } from "@/database/types";
import { QueryFields } from "@/database/utils/fields";

/** Params of a repository read by primary id. */
export interface PrimaryIdReadParams<F extends string> {
	primaryId: string;
	fields?: FieldsConfig<F> | undefined;
	tx?: DatabaseTransaction | undefined;
}

/** Params of a repository first-row read with optional field projection. */
export interface FindFirstReadParams<F extends string> {
	where?: SQL | undefined;
	fields?: FieldsConfig<F> | undefined;
	tx?: DatabaseTransaction | undefined;
}

/**
 * Delegates a by-id read to the repository's own first-row reader (`loadFirst`)
 * so a monkey-patched `findFirst`/`findByPrimaryId` still intercepts the read.
 * The repository passes its method through the lazy getter, keeping the seam.
 */
export async function selectByPrimaryId<F extends string, TRow>(
	access: { primaryKeyColumn: SQLiteColumn },
	loadFirst: (params: FindFirstReadParams<F>) => Promise<TRow | undefined>,
	{ primaryId, fields, tx }: PrimaryIdReadParams<F>,
): Promise<TRow | undefined> {
	return await loadFirst({ where: eq(access.primaryKeyColumn, primaryId), fields, tx });
}

/**
 * Shared body of projected by-id reads: select the requested columns, then
 * apply the field mask (same pairing as the table-access `findById`).
 */
export async function selectByIdWithFields<TTable extends DatabaseTables, F extends string>(
	access: TableAccessBase<TTable>,
	{ primaryId, fields, tx }: PrimaryIdReadParams<F>,
): Promise<SelectFields<TableSelect<TTable>, F> | undefined> {
	const row = await selectFirstWithFields(access, { where: eq(access.primaryKeyColumn, primaryId), tx, fields });
	if (!row) return undefined;

	return QueryFields.apply(row, fields);
}
