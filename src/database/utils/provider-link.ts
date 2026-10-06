import { eq } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";

/**
 * First provider link (external id + provider name) for a junction row of one
 * entity (metadata, person, …), or `undefined` when none is linked.
 */
export async function findFirstProviderLinkFor(
	junctionTable: SQLiteTable & { providerId: SQLiteColumn },
	entityColumn: SQLiteColumn,
	entityId: string,
	tx?: DatabaseTransaction,
): Promise<{ externalId: string; name: string } | undefined> {
	const [row] = await databaseFactory
		.getClient({ tx })
		.select({ externalId: schema.providers.externalId, name: schema.providers.name })
		.from(junctionTable)
		.innerJoin(schema.providers, eq(schema.providers.id, junctionTable.providerId))
		.where(eq(entityColumn, entityId))
		.limit(1);

	return row;
}
