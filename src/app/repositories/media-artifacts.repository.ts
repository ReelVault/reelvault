import { asc, count, desc, eq } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { defineRepository, defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";

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

/** Methods dispatch through the singleton: the lint rule forbids referencing the const before its definition. */
function getMediaArtifactsRepository() {
	return mediaArtifactsRepository;
}
