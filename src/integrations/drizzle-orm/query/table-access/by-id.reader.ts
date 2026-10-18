import { eq, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTables, DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import type { TableAccessBase, TableSelect } from "./table-access.types";

/**
 * Prepared single-row read by primary key, shared by `defineTableAccess` and
 * the by-id helpers. The overload pair carries the table row type to callers
 * while the implementation stays unknown-typed — the same pattern as
 * `selectMany`, whose generic table also defeats drizzle's inference.
 */
const preparedByIdByAccess = new WeakMap<
	object,
	(client: ReturnType<typeof databaseFactory.getClient>) => { execute: (params: { primaryId: string }) => Promise<unknown[]> }
>();

function preparedFirstById<TTable extends DatabaseTables>(
	access: TableAccessBase<TTable>,
): (client: ReturnType<typeof databaseFactory.getClient>) => { execute: (params: { primaryId: string }) => Promise<unknown[]> } {
	let prepared = preparedByIdByAccess.get(access);
	if (!prepared) {
		prepared = createPreparedQuery((client: ReturnType<typeof databaseFactory.getClient>) =>
			client
				.select()
				.from(access.table)
				.where(eq(access.primaryKeyColumn, sql.placeholder("primaryId")))
				.limit(1)
				.prepare(),
		);
		preparedByIdByAccess.set(access, prepared);
	}

	return prepared;
}

export function selectFirstByIdPrepared<TTable extends DatabaseTables>(
	access: TableAccessBase<TTable>,
	params: { primaryId: string; tx?: DatabaseTransaction | undefined },
): Promise<TableSelect<TTable> | undefined>;

export async function selectFirstByIdPrepared(
	access: TableAccessBase<DatabaseTables>,
	{ primaryId, tx }: { primaryId: string; tx?: DatabaseTransaction | undefined },
): Promise<unknown> {
	const [row] = await preparedFirstById(access)(databaseFactory.getClient({ tx })).execute({ primaryId });

	return row;
}
