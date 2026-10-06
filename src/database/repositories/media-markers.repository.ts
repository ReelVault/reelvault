import type { CreateMediaMarker } from "@reelvault/sdk/common";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { defineRepository, defineTableAccess, mapChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";

const mediaMarkers = defineTableAccess("mediaMarkers", {
	primaryKeyColumn: "id",
});

/** Default cap for marker listings when the caller passes no limit. */
const MAX_MARKER_LIST_ROWS = 5000;

const overrides = {
	async findAll(limit?: number, tx?: DatabaseTransaction) {
		// Hard cap so a marker listing without an explicit limit cannot materialize
		// the whole table.
		const effectiveLimit = limit && limit > 0 ? limit : MAX_MARKER_LIST_ROWS;

		return await getMediaMarkersRepository().selectMany({
			orderBy: asc(mediaMarkers.table.createdAt),
			limit: effectiveLimit,
			tx,
		});
	},

	async findByMediaFileId(mediaFileId: string, tx?: DatabaseTransaction) {
		return await getMediaMarkersRepository().selectMany({
			where: eq(mediaMarkers.table.mediaFileId, mediaFileId),
			orderBy: asc(mediaMarkers.table.startSeconds),
			tx,
		});
	},

	async findByMediaFileIdAndPlugin(mediaFileId: string, pluginId: string, tx?: DatabaseTransaction) {
		return await getMediaMarkersRepository().selectMany({
			where: and(eq(mediaMarkers.table.mediaFileId, mediaFileId), eq(mediaMarkers.table.pluginId, pluginId)),
			orderBy: asc(mediaMarkers.table.startSeconds),
			tx,
		});
	},

	async replaceMarkersForMediaFile(
		mediaFileId: string,
		markers: readonly CreateMediaMarker[],
		options?: { pluginId?: string; source?: "automatic" | "manual" | "plugin" },
		tx?: DatabaseTransaction,
	) {
		const runInTransaction = async (targetTx: DatabaseTransaction) => {
			// Scoped replace: a caller passing a scope (pluginId / source) replaces
			// only its own markers — wiping the whole file would let two producers
			// overwrite each other and destroy manually created markers.
			let deleteWhere: SQL | undefined = eq(mediaMarkers.table.mediaFileId, mediaFileId);
			if (options?.pluginId !== undefined) {
				deleteWhere = and(deleteWhere, eq(mediaMarkers.table.pluginId, options.pluginId));
			} else if (options?.source) {
				deleteWhere = and(deleteWhere, eq(mediaMarkers.table.source, options.source));
			}

			await getMediaMarkersRepository().delete({ where: deleteWhere, tx: targetTx });

			if (markers.length === 0) return [];

			const records = markers.map((m) => ({
				mediaFileId,
				type: m.type,
				startSeconds: m.startSeconds,
				endSeconds: m.endSeconds,
				label: m.label ?? null,
				source: m.source ?? options?.source ?? "manual",
				pluginId: m.pluginId ?? options?.pluginId ?? null,
			}));

			const inserted = await mapChunked(records, (recordChunk) =>
				databaseFactory.getClient({ tx: targetTx }).insert(mediaMarkers.table).values(recordChunk).returning(),
			);

			return inserted.toSorted((a, b) => a.startSeconds - b.startSeconds);
		};

		return tx ? await runInTransaction(tx) : await databaseFactory.transaction(runInTransaction);
	},

	async deleteByMediaFileId(mediaFileId: string, tx?: DatabaseTransaction) {
		return await getMediaMarkersRepository().delete({ where: eq(mediaMarkers.table.mediaFileId, mediaFileId), tx });
	},
};

export const mediaMarkersRepository = defineRepository(mediaMarkers, overrides);

/** Methods dispatch through the singleton so tests can monkey-patch delegations. */
function getMediaMarkersRepository() {
	return mediaMarkersRepository;
}
