import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { findMediaCleanupData, type MediaCleanupData } from "@/integrations/drizzle-orm/utils/media-cleanup.reader";
import { hasCatalogMediaStats, rebuildCatalogFromLibraries } from "@/repositories/media-stats.repository";
import { refreshLatestMediaCreatedAt } from "@/repositories/metadata/media-presence.writer";
import { clearStatsCaches, type LibraryStatsCaches } from "./shared.types";

/**
 * Deletes a library with its media files, the title rows only it used, and its scan checkpoint. Returns the cleanup
 * data the caller removes from disk once the rows are gone.
 */
export async function deleteWithDependents(caches: LibraryStatsCaches, libraryId: string): Promise<MediaCleanupData> {
	return await databaseFactory.transaction(async (tx) => {
		const client = databaseFactory.getClient({ tx });
		const [cleanup, candidateMetadata] = await Promise.all([
			findMediaCleanupData({
				where: eq(schema.mediaFiles.libraryId, libraryId),
				tx,
				filterNullSubtitlePaths: true,
			}),
			// Candidate metadata rows whose only media files belong to this library.
			// Must be captured BEFORE the media_files delete below.
			client
				.selectDistinct({ metadataId: schema.mediaFiles.metadataId })
				.from(schema.mediaFiles)
				.where(eq(schema.mediaFiles.libraryId, libraryId)),
		]);

		// `media_files.metadata_id` is NO ACTION (a metadata row can be shared by
		// media files from several libraries), so deleting metadata first violated
		// the FK and rolled the whole delete back. Delete media first, then the
		// now-orphan metadata.
		await client.delete(schema.mediaFiles).where(eq(schema.mediaFiles.libraryId, libraryId));
		await client.delete(schema.libraryMediaStats).where(eq(schema.libraryMediaStats.libraryId, libraryId));

		const candidateMetadataIds = candidateMetadata.map((row) => row.metadataId);
		await refreshLatestMediaCreatedAt(candidateMetadataIds, tx);
		await forEachChunked(candidateMetadataIds, (metadataIds) =>
			client
				.delete(schema.metadata)
				.where(
					and(
						inArray(schema.metadata.id, metadataIds),
						notExists(client.select({ one: sql`1` }).from(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, schema.metadata.id))),
					),
				),
		);

		// No FK on scan_state.library_id — delete the checkpoint explicitly so a
		// removed library leaves no orphan resume state.
		await client.delete(schema.scanState).where(eq(schema.scanState.libraryId, libraryId));
		await client.delete(schema.libraries).where(eq(schema.libraries.id, libraryId));
		if (await hasCatalogMediaStats(tx)) await rebuildCatalogFromLibraries(tx);

		clearStatsCaches(caches);

		return cleanup;
	});
}
