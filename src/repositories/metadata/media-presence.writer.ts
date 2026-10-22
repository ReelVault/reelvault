import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";

/**
 * Keeps `metadata.latest_media_created_at` in step with the media-file graph.
 * The column is the cheap replacement for the `EXISTS (SELECT … media_files)`
 * probe every catalog list ran per metadata row and for the correlated `MAX`
 * recently-added rank.
 */
export async function markLatestMediaCreatedAt(metadataId: string, createdAt: Date, tx?: DatabaseTransaction): Promise<void> {
	const client = databaseFactory.getClient({ tx });
	const seconds = Math.floor(createdAt.getTime() / 1_000);

	await client
		.update(schema.metadata)
		.set({
			latestMediaCreatedAt: sql`CASE WHEN ${schema.metadata.latestMediaCreatedAt} IS NULL OR ${schema.metadata.latestMediaCreatedAt} < ${seconds} THEN ${seconds} ELSE ${schema.metadata.latestMediaCreatedAt} END`,
		})
		.where(eq(schema.metadata.id, metadataId));
}

/** Recomputes the stored latest timestamp after media files were removed or repointed. */
export async function refreshLatestMediaCreatedAt(metadataIds: readonly string[], tx?: DatabaseTransaction): Promise<void> {
	const ids = [...new Set(metadataIds)];
	if (ids.length === 0) return;

	const client = databaseFactory.getClient({ tx });
	await forEachChunked(ids, async (chunk) => {
		await client
			.update(schema.metadata)
			.set({
				latestMediaCreatedAt: sql`(SELECT MAX(${schema.mediaFiles.createdAt}) FROM ${schema.mediaFiles} WHERE ${schema.mediaFiles.metadataId} = ${schema.metadata.id})`,
			})
			.where(inArray(schema.metadata.id, chunk));
	});
}

/**
 * One-time (idempotent) fill for databases created before the column existed.
 * Rows that legitimately have no media files stay NULL and are skipped on the
 * next boot; only titles that still have files and a NULL stamp are written.
 */
export async function backfillLatestMediaCreatedAt(tx?: DatabaseTransaction): Promise<void> {
	const client = databaseFactory.getClient({ tx });

	await client
		.update(schema.metadata)
		.set({
			latestMediaCreatedAt: sql`(SELECT MAX(${schema.mediaFiles.createdAt}) FROM ${schema.mediaFiles} WHERE ${schema.mediaFiles.metadataId} = ${schema.metadata.id})`,
		})
		.where(
			and(
				isNull(schema.metadata.latestMediaCreatedAt),
				exists(client.select({ one: sql`1` }).from(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, schema.metadata.id))),
			),
		);
}
