import type { SQL } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTables, DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import type { SelectManyParams, TableAccessBase, TableSelect } from "./table-access.types";

export function tableQuery<TTable extends DatabaseTables>(repository: TableAccessBase<TTable>, tx?: DatabaseTransaction) {
	return databaseFactory.getClient({ tx }).query[repository.tableName];
}

export async function selectMany<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	params?: SelectManyParams,
): Promise<Array<TableSelect<TTable>>>;

export async function selectMany<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	{ where, orderBy, limit, offset, tx }: SelectManyParams = {},
): Promise<unknown[]> {
	const baseQuery = databaseFactory.getClient({ tx }).select().from(repository.table).where(where).$dynamic();

	return await applyWindow(baseQuery, { orderBy, limit, offset });
}

export async function selectFirst<TTable extends DatabaseTables>(
	repository: TableAccessBase<TTable>,
	params: { where?: SQL | undefined; tx?: DatabaseTransaction | undefined } = {},
): Promise<TableSelect<TTable> | undefined> {
	const [row] = await selectMany(repository, { ...params, limit: 1 });

	return row;
}

/** Minimal chain surface shared by the dynamic select builders used below. */
interface WindowedQuery<TQuery> extends PromiseLike<unknown[]> {
	orderBy(orderBy: SQL): TQuery;
	limit(limit: number): TQuery;
	offset(offset: number): TQuery;
}

/** Shared ORDER BY / LIMIT / OFFSET window for `selectMany` and `selectManyWithFields`. */
export async function applyWindow<TQuery extends WindowedQuery<TQuery>>(
	query: TQuery,
	{ orderBy, limit, offset }: Pick<SelectManyParams, "orderBy" | "limit" | "offset">,
): Promise<unknown[]> {
	let result = orderBy ? query.orderBy(orderBy) : query;
	if (limit !== undefined) result = result.limit(limit);

	if (offset !== undefined && offset > 0) result = result.offset(offset);

	return await result;
}
