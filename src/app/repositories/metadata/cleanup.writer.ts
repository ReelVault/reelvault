import { and, asc, eq, gt, inArray, notExists, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { runInTransaction } from "@/integrations/drizzle-orm/query/transaction.utils";
import { findMediaCleanupData } from "@/integrations/drizzle-orm/utils/media-cleanup.reader";

import { metadataTable } from "./shared.utils";

export async function deleteAndGetCleanup(metadataId: string) {
	return await databaseFactory.transaction(async (tx) => {
		const cleanup = await findMediaFileCleanupData(metadataId, tx);
		await deleteWithMediaFiles({ metadataId, tx });

		return cleanup;
	});
}

/** Orphan metadata ids (no linked media files), ascending by id, keyset-paged via `afterId`. */
export async function findOrphanIds(limit?: number, afterId?: string, tx?: DatabaseTransaction): Promise<string[]> {
	const client = databaseFactory.getClient({ tx });
	const conditions = [
		notExists(client.select({ one: sql`1` }).from(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, schema.metadata.id))),
		...(afterId ? [gt(schema.metadata.id, afterId)] : []),
	];
	const query = client
		.select({ id: schema.metadata.id })
		.from(schema.metadata)
		.where(and(...conditions))
		.orderBy(asc(schema.metadata.id));
	const rows = limit === undefined ? await query : await query.limit(limit);

	return rows.map((r) => r.id);
}

export async function deleteOrphansByIds(orphanIds: string[], tx?: DatabaseTransaction): Promise<number> {
	if (orphanIds.length === 0) return 0;

	return await runInTransaction(tx, async (targetTx) => {
		const client = databaseFactory.getClient({ tx: targetTx });
		let deletedCount = 0;
		await forEachChunked(orphanIds, async (idChunk) => {
			// Re-check orphan status at delete time: a media file attached since
			// the page was fetched would make the FK abort the whole purge.
			// `.returning()` counts actual deletions — `changes` also counts
			// FTS trigger rows on this table.
			const deletedRows = await client
				.delete(schema.metadata)
				.where(
					and(
						inArray(schema.metadata.id, idChunk),
						notExists(client.select({ one: sql`1` }).from(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, schema.metadata.id))),
					),
				)
				.returning({ id: schema.metadata.id });
			deletedCount += deletedRows.length;
		});

		return deletedCount;
	});
}

export async function findMediaFileCleanupData(metadataId: string, tx?: DatabaseTransaction) {
	return await findMediaCleanupData({ where: eq(schema.mediaFiles.metadataId, metadataId), tx });
}

export async function deleteWithMediaFiles({ metadataId, tx }: { metadataId: string; tx: DatabaseTransaction }) {
	await tx.delete(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, metadataId));
	await metadataTable.delete({ primaryId: metadataId, tx });
}
