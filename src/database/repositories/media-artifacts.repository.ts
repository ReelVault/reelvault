import { desc, eq } from "drizzle-orm";
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

	async findById(id: string, tx?: DatabaseTransaction) {
		return await getMediaArtifactsRepository().selectFirst({ where: eq(mediaArtifacts.table.id, id), tx });
	},
};

export const mediaArtifactsRepository = defineRepository(mediaArtifacts, overrides);

/** Methods dispatch through the singleton so tests can monkey-patch delegations. */
function getMediaArtifactsRepository() {
	return mediaArtifactsRepository;
}
