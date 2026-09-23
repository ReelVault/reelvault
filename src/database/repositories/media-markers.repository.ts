import type { CreateMediaMarker } from "@sdk/common/media-markers";
import { and, asc, eq, type SQL } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { defineTableAccess, mapChunked } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";

const mediaMarkers = defineTableAccess("mediaMarkers", {
	primaryKeyColumn: "id",
});

/** Default cap for marker listings when the caller passes no limit. */
const MAX_MARKER_LIST_ROWS = 5000;

class MediaMarkersRepository {
	readonly table = schema.mediaMarkers;
	readonly selectMany = mediaMarkers.selectMany;
	readonly selectFirst = mediaMarkers.selectFirst;
	readonly insert = mediaMarkers.insert;
	readonly insertReturning = mediaMarkers.insertReturning;
	readonly update = mediaMarkers.update;
	readonly updateReturning = mediaMarkers.updateReturning;
	readonly delete = mediaMarkers.delete;
	readonly deleteReturning = mediaMarkers.deleteReturning;
	readonly deleteAndReturn = mediaMarkers.deleteAndReturn;
	readonly findByIds = mediaMarkers.findByIds;
	readonly findByColumnIn = mediaMarkers.findByColumnIn;

	async findAll(limit?: number, tx?: DatabaseTransaction) {
		// Hard cap so a marker listing without an explicit limit cannot materialize
		// the whole table.
		const effectiveLimit = limit && limit > 0 ? limit : MAX_MARKER_LIST_ROWS;

		return await this.selectMany({
			orderBy: asc(this.table.createdAt),
			limit: effectiveLimit,
			tx,
		});
	}

	async findByMediaFileId(mediaFileId: string, tx?: DatabaseTransaction) {
		return await this.selectMany({
			where: eq(this.table.mediaFileId, mediaFileId),
			orderBy: asc(this.table.startSeconds),
			tx,
		});
	}

	async findByMediaFileIdAndPlugin(mediaFileId: string, pluginId: string, tx?: DatabaseTransaction) {
		return await this.selectMany({
			where: and(eq(this.table.mediaFileId, mediaFileId), eq(this.table.pluginId, pluginId)),
			orderBy: asc(this.table.startSeconds),
			tx,
		});
	}

	async findByMediaFileIds(mediaFileIds: readonly string[], tx?: DatabaseTransaction) {
		return await mediaMarkers.findByColumnIn(this.table.mediaFileId, mediaFileIds, {
			orderBy: asc(this.table.startSeconds),
			tx,
		});
	}

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
			let deleteWhere: SQL | undefined = eq(this.table.mediaFileId, mediaFileId);
			if (options?.pluginId !== undefined) {
				deleteWhere = and(deleteWhere, eq(this.table.pluginId, options.pluginId));
			} else if (options?.source) {
				deleteWhere = and(deleteWhere, eq(this.table.source, options.source));
			}

			await this.delete({ where: deleteWhere, tx: targetTx });

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
				databaseFactory.getClient({ tx: targetTx }).insert(this.table).values(recordChunk).returning(),
			);

			return inserted.toSorted((a, b) => a.startSeconds - b.startSeconds);
		};

		return tx ? await runInTransaction(tx) : await databaseFactory.transaction(runInTransaction);
	}

	async deleteByMediaFileId(mediaFileId: string, tx?: DatabaseTransaction) {
		return await this.delete({ where: eq(this.table.mediaFileId, mediaFileId), tx });
	}
}

export const mediaMarkersRepository = new MediaMarkersRepository();
