import { librariesRepository } from "@/repositories/libraries.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import type { AdminAuditContext } from "@/services/admin/audit-context.types";
import { deleteWithArtifacts } from "@/services/artifacts/delete-with-artifacts";
import { runBulkItems } from "@/services/catalog/catalog.utils";
import { mediaFilesLog } from "@/services/media/media-files/media-files.logger";
import { getById } from "@/services/media/media-files/queries.reader";
import { assertNoActiveStreamsForMediaFileIds } from "@/services/playback/active-streams.guard";
import { CATALOG_LIST_PATH_PREFIXES, invalidateResponseBodiesForPathPrefixes } from "@/utils/response-body.cache";
import { runSafely } from "@/utils/safe-execute.utils";

/**
 * Removes the listed media file records one after another; each id reports its own outcome. Files a stream is playing are
 * held back unless `force` is set, because deleting the record ends that playback.
 */
export async function deleteMany(mediaFileIds: string[], options: { force?: boolean | undefined } = {}, context?: AdminAuditContext) {
	return await runSafely(mediaFilesLog, "deleteMany", async () => {
		const ids = [...new Set(mediaFileIds)];
		assertNoActiveStreamsForMediaFileIds(new Set(ids), {
			force: options.force,
			message: "Delete is blocked while streams are playing these files",
			code: "media.delete_blocked_active_streams",
		});

		return await runBulkItems(ids, (id) => deleteOne(id, context, { force: options.force === true }), "media.delete_failed");
	});
}

export async function deleteOne(
	mediaFileId: string,
	context?: AdminAuditContext,
	options: { force?: boolean | undefined } = {},
): Promise<{ success: boolean }> {
	return await runSafely(mediaFilesLog, "delete", async () => {
		// getById already asserts existence (404) — no redundant second check needed.
		const mediaFile = await getById(mediaFileId, { fields: "id" });
		// The same protection the bulk path enforces: deleting the record ends playback.
		assertNoActiveStreamsForMediaFileIds(mediaFileId, {
			force: options.force,
			message: "Delete is blocked while a stream is playing this file",
			code: "media.delete_blocked_active_streams",
		});

		const cleanup = await mediaRepository.deleteAndGetCleanup(mediaFileId);
		await deleteWithArtifacts({
			cleanup,
			resourceType: "media_file",
			resourceId: mediaFileId,
			before: mediaFile,
			// File counts/sizes in the library stats cache changed, and cached list
			// bodies may still embed the deleted row.
			invalidate: () => {
				librariesRepository.clearStatsCache();
				invalidateResponseBodiesForPathPrefixes(CATALOG_LIST_PATH_PREFIXES);
			},
			context,
			logger: mediaFilesLog.logger,
		});

		return { success: true };
	});
}
