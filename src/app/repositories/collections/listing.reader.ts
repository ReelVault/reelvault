import { and, count, eq, exists, type SQL, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";

export interface QualifyingScope {
	where?: SQL | undefined;
	minItems: number;
	tx?: DatabaseTransaction | undefined;
}

export interface QualifyingPage extends QualifyingScope {
	orderBy?: SQL | undefined;
	limit: number;
	offset: number;
}

/**
 * Collections whose metadata-item count meets `minItems`. The previous
 * grouped join counted every junction row of the whole catalog; probing for
 * the `minItems`-th row rides the (collection_id, metadata_id) index and
 * stops after `minItems` entries per collection — O(collections × minItems)
 * instead of O(junction rows).
 */
function qualifyingCollections({ where, minItems, tx }: QualifyingScope) {
	const client = databaseFactory.getClient({ tx });
	const minimumCount = Math.max(minItems, 1);
	// EXISTS only asks for one row, so `LIMIT minimumCount` alone matched every
	// non-empty collection. OFFSET minimumCount - 1 makes it probe for the
	// minimumCount-th row instead.
	const qualifies = exists(
		client
			.select({ one: sql`1` })
			.from(schema.metadataCollections)
			.where(eq(schema.metadataCollections.collectionId, schema.collections.id))
			.limit(1)
			.offset(minimumCount - 1),
	);

	return client.select({ id: schema.collections.id }).from(schema.collections).where(and(where, qualifies));
}

/** Total collections meeting the `minItems` threshold, computed in SQL (no id materialization). */
export async function countQualifyingCollections(scope: QualifyingScope): Promise<number> {
	const subquery = qualifyingCollections(scope).as("qualifying_collections");
	const [row] = await databaseFactory.getClient({ tx: scope.tx }).select({ value: count() }).from(subquery);

	return row?.value ?? 0;
}

/** Ordered page of qualifying collection ids — pushes LIMIT/OFFSET into SQL. */
export async function findQualifyingCollectionIds({ orderBy, limit, offset, ...scope }: QualifyingPage): Promise<string[]> {
	const base = qualifyingCollections(scope);
	const ordered = orderBy ? base.orderBy(orderBy) : base;
	const rows = await ordered.limit(limit).offset(offset);

	return rows.map((row) => row.id);
}
