import type { FieldsConfig, FieldsQuery, SelectFields } from "@reelvault/sdk/common";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { parseFieldsForRead } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";

/** Params handed to a repository's own hydrating by-id reader. */
export interface ReadByIdParams<F extends string> {
	primaryId: string;
	fields: FieldsConfig<F>;
	tx?: DatabaseTransaction | undefined;
}

type ReadByIdLoader<TRow> = <F extends string>(params: ReadByIdParams<F>) => Promise<SelectFields<TRow, F> | undefined>;

/**
 * Builds the `findByIdForRead` entry point shared by every repository: parse
 * the standard fields query, then call the repository's *own* hydrating by-id
 * reader (`findById`/`findByPrimaryId`), never the flat table-access twin that
 * silently drops relations. The loader is supplied per repository so each keeps
 * its hydration override.
 */
export function defineFindByIdForRead<TRow>(load: ReadByIdLoader<TRow>) {
	return async <F extends string>(id: string, query?: FieldsQuery<F>): Promise<SelectFields<TRow, F> | undefined> =>
		await load({ primaryId: id, fields: parseFieldsForRead(query) });
}
