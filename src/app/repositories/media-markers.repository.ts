import type { CreateMediaMarker, MediaMarkerFilters } from "@reelvault/sdk/common";
import { and, asc, eq, inArray, or, type SQL } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { filterLike } from "@/integrations/drizzle-orm/query/parsing/filtering.parser";
import { forEachChunked, mapChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { defineRepository, defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { runInTransaction } from "@/integrations/drizzle-orm/query/transaction.utils";
import { groupBy } from "@/utils/array.utils";

const mediaMarkers = defineTableAccess("mediaMarkers", {
	primaryKeyColumn: "id",
});

/** Default cap for marker listings when the caller passes no limit. */
const MAX_MARKER_LIST_ROWS = 5000;

/** Admin list filters plus the row cap. */
export type MediaMarkerListQuery = MediaMarkerFilters & { limit?: number };

/** Filters are ANDed. `q` matches as a substring of the label, file id, plugin id or type. */
function markerListWhere(query: MediaMarkerListQuery): SQL | undefined {
	const term = query.q?.trim();

	let termFilter: SQL | undefined;
	if (term) {
		termFilter = or(
			filterLike(mediaMarkers.table.label, term),
			filterLike(mediaMarkers.table.mediaFileId, term),
			filterLike(mediaMarkers.table.pluginId, term),
			filterLike(mediaMarkers.table.type, term),
		);
	}

	return and(
		query.type ? eq(mediaMarkers.table.type, query.type) : undefined,
		query.source ? eq(mediaMarkers.table.source, query.source) : undefined,
		termFilter,
	);
}

const overrides = {
	async findPage(query: MediaMarkerFilters & { limit: number; offset: number }) {
		const where = markerListWhere(query);
		const { data, total } = await mediaMarkers.findOffsetPage({
			where,
			orderBy: asc(mediaMarkers.table.createdAt),
			limit: query.limit,
			offset: query.offset,
			tiebreakerOrder: "asc",
		});

		return { rows: data, total };
	},

	async findAll(query: MediaMarkerListQuery = {}, tx?: DatabaseTransaction) {
		// Hard cap so a marker listing without an explicit limit cannot materialize
		// the whole table.
		const effectiveLimit = query.limit && query.limit > 0 ? query.limit : MAX_MARKER_LIST_ROWS;

		return await getMediaMarkersRepository().selectMany({
			where: markerListWhere(query),
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
		return await runInTransaction(tx, async (targetTx) => {
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
		});
	},

	/**
	 * Replaces the markers of many files in one pass: one before-snapshot read,
	 * one scoped delete per chunk and one insert per chunk, instead of a round
	 * trip per file. Returns the per-file before/after snapshots for the caller's
	 * audit entries; every file in `grouped` gets an entry, even when empty.
	 */
	async replaceMarkersForMediaFiles(
		grouped: ReadonlyMap<string, readonly CreateMediaMarker[]>,
		options?: { pluginId?: string; source?: "automatic" | "manual" | "plugin" },
		tx?: DatabaseTransaction,
	): Promise<Map<string, { before: Array<typeof mediaMarkers.table.$inferSelect>; after: Array<typeof mediaMarkers.table.$inferSelect> }>> {
		const mediaFileIds = [...grouped.keys()];
		if (mediaFileIds.length === 0) return new Map();

		return await runInTransaction(tx, async (targetTx) => {
			const client = databaseFactory.getClient({ tx: targetTx });
			const before = await mapChunked(mediaFileIds, (chunkIds) =>
				getMediaMarkersRepository().selectMany({
					where: inArray(mediaMarkers.table.mediaFileId, chunkIds),
					orderBy: asc(mediaMarkers.table.startSeconds),
					tx: targetTx,
				}),
			);

			// Scoped replace, like the single-file path: a producer only wipes its own rows.
			await forEachChunked(mediaFileIds, (chunkIds) => {
				let deleteWhere: SQL | undefined = inArray(mediaMarkers.table.mediaFileId, chunkIds);
				if (options?.pluginId !== undefined) {
					deleteWhere = and(deleteWhere, eq(mediaMarkers.table.pluginId, options.pluginId));
				} else if (options?.source) {
					deleteWhere = and(deleteWhere, eq(mediaMarkers.table.source, options.source));
				}

				return getMediaMarkersRepository().delete({ where: deleteWhere, tx: targetTx });
			});

			const records = [...grouped].flatMap(([mediaFileId, items]) =>
				items.map((marker) => ({
					mediaFileId,
					type: marker.type,
					startSeconds: marker.startSeconds,
					endSeconds: marker.endSeconds,
					label: marker.label ?? null,
					source: marker.source ?? options?.source ?? "manual",
					pluginId: marker.pluginId ?? options?.pluginId ?? null,
				})),
			);
			let inserted: Array<typeof mediaMarkers.table.$inferSelect> = [];
			if (records.length > 0) {
				inserted = await mapChunked(records, (recordChunk) => client.insert(mediaMarkers.table).values(recordChunk).returning());
			}

			const beforeByFile = groupBy(before, (row) => row.mediaFileId);
			const afterByFile = groupBy(inserted, (row) => row.mediaFileId);
			const snapshots = new Map<
				string,
				{ before: Array<typeof mediaMarkers.table.$inferSelect>; after: Array<typeof mediaMarkers.table.$inferSelect> }
			>();
			for (const mediaFileId of mediaFileIds) {
				snapshots.set(mediaFileId, {
					before: beforeByFile.get(mediaFileId) ?? [],
					after: (afterByFile.get(mediaFileId) ?? []).toSorted((a, b) => a.startSeconds - b.startSeconds),
				});
			}

			return snapshots;
		});
	},

	async deleteByMediaFileId(mediaFileId: string, tx?: DatabaseTransaction) {
		return await getMediaMarkersRepository().delete({ where: eq(mediaMarkers.table.mediaFileId, mediaFileId), tx });
	},
};

export const mediaMarkersRepository = defineRepository(mediaMarkers, overrides);

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getMediaMarkersRepository() {
	return mediaMarkersRepository;
}
