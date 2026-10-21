import { eq, isNotNull } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";

/** Episode files joined to their episode, unordered, for plugins that group the catalog by season. */
export async function findEpisodeFileRowsForPlugins() {
	return await databaseFactory
		.getClient()
		.select({
			mediaFileId: schema.mediaFiles.id,
			filePath: schema.mediaFiles.filePath,
			fileName: schema.mediaFiles.fileName,
			duration: schema.mediaFiles.duration,
			episodeId: schema.episodes.id,
			seasonId: schema.episodes.seasonId,
			episodeNumber: schema.episodes.episodeNumber,
			title: schema.episodes.title,
		})
		.from(schema.mediaFiles)
		.innerJoin(schema.episodes, eq(schema.mediaFiles.episodeId, schema.episodes.id))
		.where(isNotNull(schema.mediaFiles.episodeId));
}

/** One page of every media file in id order, with its title for plugins that list the whole catalog. */
export async function findFileRowsPageForPlugins(options: { limit: number; offset: number }) {
	return await databaseFactory
		.getClient()
		.select({
			mediaFileId: schema.mediaFiles.id,
			filePath: schema.mediaFiles.filePath,
			fileName: schema.mediaFiles.fileName,
			duration: schema.mediaFiles.duration,
			movieId: schema.mediaFiles.movieId,
			episodeId: schema.mediaFiles.episodeId,
			metadataTitle: schema.metadata.title,
		})
		.from(schema.mediaFiles)
		.leftJoin(schema.metadata, eq(schema.mediaFiles.metadataId, schema.metadata.id))
		.orderBy(schema.mediaFiles.id)
		.limit(options.limit)
		.offset(options.offset);
}
