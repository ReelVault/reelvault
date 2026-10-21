import type { PlaybackArtifactKind } from "@reelvault/sdk/common";
import { and, asc, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { defineRepository, defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";

const mediaArtifacts = defineTableAccess("mediaArtifacts", {
	primaryKeyColumn: "id",
});

/**
 * The scope of an artifact read: one or more files, one kind and (optionally)
 * one owner. A single file keeps the `=` comparison, so the
 * `(media_file_id, kind, plugin_id)` index serves it best.
 */
function artifactScopeWhere(mediaFileIds: readonly string[], kind: PlaybackArtifactKind, ownerId?: string): SQL | undefined {
	const [first] = mediaFileIds;
	const fileFilter =
		first !== undefined && mediaFileIds.length === 1
			? eq(mediaArtifacts.table.mediaFileId, first)
			: inArray(mediaArtifacts.table.mediaFileId, [...mediaFileIds]);

	return and(fileFilter, eq(mediaArtifacts.table.kind, kind), ...(ownerId ? [eq(mediaArtifacts.table.pluginId, ownerId)] : []));
}

const overrides = {
	async findByMediaFileId(mediaFileId: string, tx?: DatabaseTransaction) {
		return await getMediaArtifactsRepository().selectMany({
			where: eq(mediaArtifacts.table.mediaFileId, mediaFileId),
			orderBy: desc(mediaArtifacts.table.createdAt),
			tx,
		});
	},

	async findByPluginId(pluginId: string, tx?: DatabaseTransaction) {
		return await getMediaArtifactsRepository().selectMany({ where: eq(mediaArtifacts.table.pluginId, pluginId), tx });
	},

	/** The artifacts of one file, of one kind and (optionally) one owner — the filters live in SQL. */
	async findByMediaFileIdAndKind(mediaFileId: string, kind: PlaybackArtifactKind, ownerId?: string, tx?: DatabaseTransaction) {
		return await getMediaArtifactsRepository().selectMany({
			where: artifactScopeWhere([mediaFileId], kind, ownerId),
			orderBy: desc(mediaArtifacts.table.createdAt),
			tx,
		});
	},

	/** The artifacts of several files, of one kind and (optionally) one owner — one read for the whole batch. */
	async findByMediaFileIdsAndKind(mediaFileIds: readonly string[], kind: PlaybackArtifactKind, ownerId?: string, tx?: DatabaseTransaction) {
		if (mediaFileIds.length === 0) return [];

		return await getMediaArtifactsRepository().selectMany({
			where: artifactScopeWhere(mediaFileIds, kind, ownerId),
			orderBy: desc(mediaArtifacts.table.createdAt),
			tx,
		});
	},

	/** How many artifacts of one file, kind and (optionally) owner exist — a count, not a row read. */
	async countByMediaFileIdAndKind(mediaFileId: string, kind: PlaybackArtifactKind, ownerId?: string): Promise<number> {
		const [row] = await databaseFactory
			.getClient()
			.select({ count: count() })
			.from(mediaArtifacts.table)
			.where(artifactScopeWhere([mediaFileId], kind, ownerId));

		return row?.count ?? 0;
	},

	/** Artifact rows per owner and kind: what each plugin and core keep stored, for the admin overview. */
	async countByOwnerAndKind(): Promise<Array<{ pluginId: string; kind: string; count: number }>> {
		return await databaseFactory
			.getClient()
			.select({ pluginId: mediaArtifacts.table.pluginId, kind: mediaArtifacts.table.kind, count: count() })
			.from(mediaArtifacts.table)
			.groupBy(mediaArtifacts.table.pluginId, mediaArtifacts.table.kind)
			.orderBy(asc(mediaArtifacts.table.pluginId), asc(mediaArtifacts.table.kind));
	},

	async findById(id: string, tx?: DatabaseTransaction) {
		return await getMediaArtifactsRepository().selectFirst({ where: eq(mediaArtifacts.table.id, id), tx });
	},
};

export const mediaArtifactsRepository = defineRepository(mediaArtifacts, overrides);

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getMediaArtifactsRepository() {
	return mediaArtifactsRepository;
}
