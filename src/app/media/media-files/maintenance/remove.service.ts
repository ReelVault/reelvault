import { recordAuditSafe } from "@/app/admin/admin-audit.service";
import { runMediaCleanup } from "@/app/artifacts/media-cleanup.cleaner";
import { runBulkItems } from "@/app/catalog/catalog.utils";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { librariesRepository } from "@/app/repositories/libraries.repository";
import { mediaRepository } from "@/app/repositories/media-files.repository";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { DomainError } from "@/utils/domain.errors";
import { CATALOG_LIST_PATH_PREFIXES, invalidateResponseBodiesForPathPrefixes } from "@/utils/response-body.cache";
import { runSafely } from "@/utils/safe-execute.utils";
import type { getById } from "../queries.reader";
import type { MediaServiceState, WithoutState } from "../shared.utils";

type DeleteOne = (
	mediaFileId: string,
	context?: AdminAuditContext,
	options?: { force?: boolean | undefined },
) => Promise<{ success: boolean }>;

/**
 * Removes the listed media file records one after another; each id reports its own outcome. Files a stream is playing are
 * held back unless `force` is set, because deleting the record ends that playback.
 */
export async function deleteMany(
	state: MediaServiceState,
	mediaFileIds: string[],
	options: { force?: boolean | undefined },
	context: AdminAuditContext | undefined,
	deleteOneFn: DeleteOne,
) {
	return await runSafely(state, "deleteMany", async () => {
		const ids = [...new Set(mediaFileIds)];
		const idSet = new Set(ids);
		const activeStreams = [...streamingManager.getActiveMediaFileIds()].filter((mediaFileId) => idSet.has(mediaFileId)).length;
		if (activeStreams > 0 && options.force !== true) {
			throw new DomainError("conflict", "Delete is blocked while streams are playing these files", {
				code: "media.delete_blocked_active_streams",
				params: { activeStreams },
			});
		}

		return await runBulkItems(ids, (id) => deleteOneFn(id, context, { force: options.force === true }), "media.delete_failed");
	});
}

export async function deleteOne(
	state: MediaServiceState,
	mediaFileId: string,
	context: AdminAuditContext | undefined,
	getOne: (...args: WithoutState<typeof getById>) => ReturnType<typeof getById>,
	options: { force?: boolean | undefined } = {},
): Promise<{ success: boolean }> {
	return await runSafely(state, "delete", async () => {
		// getById already asserts existence (404) — no redundant second check needed.
		const mediaFile = await getOne(mediaFileId, { fields: "id" });
		// The same protection the bulk path enforces: deleting the record ends playback.
		if (options.force !== true) {
			const activeStreams = streamingManager.getActiveMediaFileIds().has(mediaFileId) ? 1 : 0;
			if (activeStreams > 0) {
				throw new DomainError("conflict", "Delete is blocked while a stream is playing this file", {
					code: "media.delete_blocked_active_streams",
					params: { activeStreams },
				});
			}
		}

		const cleanup = await mediaRepository.deleteAndGetCleanup(mediaFileId);
		await runMediaCleanup(cleanup);

		// File counts/sizes in the library stats cache changed, and cached list
		// bodies may still embed the deleted row.
		librariesRepository.clearStatsCache();
		invalidateResponseBodiesForPathPrefixes(CATALOG_LIST_PATH_PREFIXES);

		recordAuditSafe(
			{
				action: "delete",
				resourceType: "media_file",
				resourceId: mediaFileId,
				before: mediaFile,
				context,
			},
			state.logger,
		);

		return { success: true };
	});
}
