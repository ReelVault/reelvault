import { desc, eq } from "drizzle-orm";
import { schema } from "@/database/schema";
import { defineTableAccess } from "@/database/table-access";
import type { DatabaseTransaction } from "@/database/types";

const mediaArtifacts = defineTableAccess("mediaArtifacts", {
	primaryKeyColumn: "id",
});

class MediaArtifactsRepository {
	readonly table = schema.mediaArtifacts;
	readonly selectMany = mediaArtifacts.selectMany;
	readonly selectFirst = mediaArtifacts.selectFirst;
	readonly insert = mediaArtifacts.insert;
	readonly insertReturning = mediaArtifacts.insertReturning;
	readonly update = mediaArtifacts.update;
	readonly updateReturning = mediaArtifacts.updateReturning;
	readonly delete = mediaArtifacts.delete;
	readonly deleteReturning = mediaArtifacts.deleteReturning;
	readonly deleteAndReturn = mediaArtifacts.deleteAndReturn;
	readonly findByIds = mediaArtifacts.findByIds;
	readonly findByColumnIn = mediaArtifacts.findByColumnIn;

	async findByMediaFileId(mediaFileId: string, tx?: DatabaseTransaction) {
		return await this.selectMany({ where: eq(this.table.mediaFileId, mediaFileId), orderBy: desc(this.table.createdAt), tx });
	}

	async findByMediaFileIds(mediaFileIds: readonly string[], tx?: DatabaseTransaction) {
		return await mediaArtifacts.findByColumnIn(this.table.mediaFileId, mediaFileIds, { tx });
	}

	async findByPluginId(pluginId: string, tx?: DatabaseTransaction) {
		return await this.selectMany({ where: eq(this.table.pluginId, pluginId), tx });
	}

	async findById(id: string, tx?: DatabaseTransaction) {
		return await this.selectFirst({ where: eq(this.table.id, id), tx });
	}
}

export const mediaArtifactsRepository = new MediaArtifactsRepository();
