import { asc, count, desc, eq } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { defineRepository, defineTableAccess } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";

const mediaArtifacts = defineTableAccess("mediaArtifacts", {
	primaryKeyColumn: "id",
});

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

/** Methods dispatch through the singleton so tests can monkey-patch delegations. */
function getMediaArtifactsRepository() {
	return mediaArtifactsRepository;
}
