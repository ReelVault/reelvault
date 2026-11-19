import { sleep } from "bun";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { serverConfig } from "@/config/server/server.config";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { collectKeysetPages } from "@/integrations/drizzle-orm/query/keyset/keyset-pages.utils";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { findCleanupDataForMediaFileIds, type MediaCleanupData } from "@/integrations/drizzle-orm/utils/media-cleanup.reader";
import { hasCatalogMediaStats, rebuildCatalogFromLibraries } from "@/repositories/media-stats.repository";
import { deleteOrphansByIds } from "@/repositories/metadata/cleanup.writer";
import { refreshLatestMediaCreatedAt } from "@/repositories/metadata/media-presence.writer";
import { clearStatsCaches, type LibraryStatsCaches } from "./shared.types";

/** Empty accumulator for the per-page cleanup data. */
function emptyCleanup(): MediaCleanupData {
	return { artifactStorageKeys: [], subtitleFilePaths: [], subtitleIds: [] };
}

function mergeCleanup(target: MediaCleanupData, page: MediaCleanupData): void {
	target.artifactStorageKeys.push(...page.artifactStorageKeys);
	target.subtitleFilePaths.push(...page.subtitleFilePaths);
	target.subtitleIds.push(...page.subtitleIds);
}

/**
 * Deletes a library with its media files, the title rows only it used, and its scan checkpoint. Returns the cleanup
 * data the caller removes from disk once the rows are gone.
 *
 * Media rows are read and deleted in keyset pages, each in its own short transaction. A 100k-file library no longer
 * holds the single SQLite write lock (and the event loop) for the whole delete. A concurrent ingest may add a row
 * between pages; the final transaction deletes any such straggler before the library row, and the artifact sweeper
 * owns the files this pass could not name.
 */
export async function deleteWithDependents(
	caches: LibraryStatsCaches,
	libraryId: string,
	pageSize = serverConfig.database.queryChunkSize,
): Promise<MediaCleanupData> {
	const cleanup = emptyCleanup();
	const candidateMetadataIds = new Set<string>();

	// awaits: sequential — the title stamp is refreshed from the media rows that remain, so it follows every page delete
	await collectKeysetPages({
		pageSize,
		fetchPage: async (cursor) =>
			await databaseFactory
				.getClient()
				.select({ id: schema.mediaFiles.id, metadataId: schema.mediaFiles.metadataId })
				.from(schema.mediaFiles)
				.where(and(eq(schema.mediaFiles.libraryId, libraryId), cursor ? gt(schema.mediaFiles.id, cursor) : undefined))
				.orderBy(asc(schema.mediaFiles.id))
				.limit(pageSize),
		onPage: async (page) => {
			const ids = page.map((row) => row.id);
			for (const row of page) candidateMetadataIds.add(row.metadataId);
			mergeCleanup(cleanup, await findCleanupDataForMediaFileIds(ids));

			await databaseFactory.transaction(async (tx) => {
				await databaseFactory.getClient({ tx }).delete(schema.mediaFiles).where(inArray(schema.mediaFiles.id, ids));
			});
		},
		betweenPages: async () => await sleep(0),
	});

	// Titles shared with another library stay; titles whose only files were here are removed.
	await refreshLatestMediaCreatedAt([...candidateMetadataIds]);
	await forEachChunked([...candidateMetadataIds], async (metadataIds) => {
		await deleteOrphansByIds(metadataIds);
	});

	await databaseFactory.transaction(async (tx) => {
		const client = databaseFactory.getClient({ tx });
		// A media row inserted while the pages were being deleted still has to go
		// before the library row, or the FK blocks the delete.
		await client.delete(schema.mediaFiles).where(eq(schema.mediaFiles.libraryId, libraryId));
		await client.delete(schema.libraryMediaStats).where(eq(schema.libraryMediaStats.libraryId, libraryId));
		// No FK on scan_state.library_id — delete the checkpoint explicitly so a
		// removed library leaves no orphan resume state.
		await client.delete(schema.scanState).where(eq(schema.scanState.libraryId, libraryId));
		await client.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
		if (await hasCatalogMediaStats(tx)) await rebuildCatalogFromLibraries(tx);
	});

	clearStatsCaches(caches);

	return cleanup;
}
