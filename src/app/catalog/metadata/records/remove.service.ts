import { recordAuditSafe } from "@/app/admin/admin-audit.service";
import { runMediaCleanup } from "@/app/artifacts/media-cleanup.cleaner";
import { runBulkItems } from "@/app/catalog/catalog.utils";
import type { AdminAuditContext } from "@/app/repositories/admin-audit.repository";
import { mediaRepository } from "@/app/repositories/media-files.repository";
import { metadataRepository } from "@/app/repositories/metadata.repository";
import { serverConfig } from "@/config/server/server.config";
import { collectKeysetPages } from "@/integrations/drizzle-orm/query/keyset/keyset-pages.utils";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { runSafely } from "@/utils/safe-execute.utils";
import { invalidateReadCaches, type MetadataServiceState, type WithoutState } from "./shared.utils";

/** Ids kept in the `metadata_orphans` audit payload (the full set is unbounded). */
const MAX_ORPHAN_AUDIT_IDS = 50;

type DeleteOne = (...args: WithoutState<typeof deleteOne>) => ReturnType<typeof deleteOne>;

/**
 * Removes the listed titles one after another; each id reports its own outcome. A title whose files a stream is playing is
 * held back unless `force` is set, because its files lose their title while playing.
 */
export async function deleteMany(
	state: MetadataServiceState,
	metadataIds: string[],
	options: { force?: boolean | undefined },
	context: AdminAuditContext | undefined,
	deleteOneOf: DeleteOne,
) {
	return await runSafely(state, "deleteMany", async () => {
		const ids = [...new Set(metadataIds)];
		const linkedFileIds = new Set(await mediaRepository.findIdsByMetadataIds(ids));
		const activeStreams = streamingManager.getAllActiveSessions().filter((session) => linkedFileIds.has(session.mediaFileId)).length;
		if (activeStreams > 0 && options.force !== true) {
			throw new DomainError("conflict", "Delete is blocked while streams are playing these titles", {
				code: "metadata.delete_blocked_active_streams",
				params: { activeStreams },
			});
		}

		return await runBulkItems(ids, (id) => deleteOneOf(id, context, { force: options.force === true }), "metadata.delete_failed");
	});
}

export async function deleteOne(
	state: MetadataServiceState,
	metadataId: string,
	context?: AdminAuditContext,
	options: { force?: boolean | undefined } = {},
): Promise<{ success: boolean }> {
	return await runSafely(state, "delete", async () => {
		const metadata = await metadataRepository.findByIdForRead(metadataId);
		assertFound(metadata, "Metadata", metadataId);
		// The same protection the bulk path enforces: deleting the title ends its streams.
		if (options.force !== true) {
			const linkedFileIds = new Set(await mediaRepository.findIdsByMetadataIds([metadataId]));
			const activeStreams = streamingManager.getAllActiveSessions().filter((session) => linkedFileIds.has(session.mediaFileId)).length;
			if (activeStreams > 0) {
				throw new DomainError("conflict", "Delete is blocked while a stream is playing this title", {
					code: "metadata.delete_blocked_active_streams",
					params: { activeStreams },
				});
			}
		}

		const cleanup = await metadataRepository.deleteAndGetCleanup(metadataId);
		await runMediaCleanup(cleanup);
		invalidateReadCaches();

		recordAuditSafe(
			{
				action: "delete",
				resourceType: "metadata",
				resourceId: metadataId,
				before: metadata,
				context,
			},
			state.logger,
		);

		return { success: true };
	});
}

export async function deleteOrphans(state: MetadataServiceState, context?: AdminAuditContext): Promise<{ count: number }> {
	return await runSafely(state, "deleteOrphans", async () => {
		// Page the purge so a huge orphan set is never materialized at once, and
		// keep only a bounded sample in the audit payload (the full id list bloated
		// the audit row forever).
		const pageSize = serverConfig.database.queryChunkSize;
		const sample: string[] = [];
		let deleted = 0;
		const seen = await collectKeysetPages({
			pageSize,
			// Keyset by id: pages fetched after a delete cannot re-fetch the same
			// rows, and a row that stopped being an orphan (a media file attached
			// concurrently) is simply skipped instead of aborting the purge.
			fetchPage: (cursor) => metadataRepository.findOrphanIds(pageSize, cursor),
			onPage: async (orphanIds) => {
				deleted += await metadataRepository.deleteOrphansByIds(orphanIds);
				if (sample.length < MAX_ORPHAN_AUDIT_IDS) {
					sample.push(...orphanIds.slice(0, MAX_ORPHAN_AUDIT_IDS - sample.length));
				}
			},
		});

		if (deleted > 0) invalidateReadCaches();

		recordAuditSafe(
			{
				action: "delete",
				resourceType: "metadata_orphans",
				after: { count: deleted, deletedIds: sample, truncated: seen > sample.length },
				context,
			},
			state.logger,
		);

		return { count: deleted };
	});
}
