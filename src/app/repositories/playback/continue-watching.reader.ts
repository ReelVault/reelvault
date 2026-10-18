import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import { metadataImageOn } from "@/integrations/drizzle-orm/utils/join-conditions.utils";
import { findSeasonsAndEpisodes, metadataIdsJsonTable, type PlaybackRelationClient } from "./seasons.reader";

const preparedContinueWatchingProgress = createPreparedQuery((client: PlaybackRelationClient) =>
	client
		.select({
			id: schema.playbackProgress.id,
			profileId: schema.playbackProgress.profileId,
			mediaFileId: schema.playbackProgress.mediaFileId,
			position: schema.playbackProgress.position,
			duration: schema.playbackProgress.duration,
			completed: schema.playbackProgress.completed,
			audioStreamIndex: schema.playbackProgress.audioStreamIndex,
			subtitleId: schema.playbackProgress.subtitleId,
			updatedAt: schema.playbackProgress.updatedAt,
			dismissedAt: schema.playbackProgress.dismissedAt,
			metadataId: schema.mediaFiles.metadataId,
			movieId: schema.mediaFiles.movieId,
			episodeId: schema.mediaFiles.episodeId,
		})
		.from(schema.playbackProgress)
		.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.playbackProgress.mediaFileId))
		.where(eq(schema.playbackProgress.profileId, sql.placeholder("profileId")))
		.orderBy(desc(schema.playbackProgress.updatedAt))
		.limit(sql.placeholder("fetchLimit"))
		.prepare(),
);

const preparedContinueWatchingMetadata = createPreparedQuery((client: PlaybackRelationClient) =>
	client
		.select({ id: schema.metadata.id, title: schema.metadata.title, type: schema.metadata.type })
		.from(schema.metadata)
		.where(inArray(schema.metadata.id, metadataIdsJsonTable))
		.prepare(),
);

const preparedContinueWatchingMediaFiles = createPreparedQuery((client: PlaybackRelationClient) =>
	client
		.select({
			id: schema.mediaFiles.id,
			metadataId: schema.mediaFiles.metadataId,
			movieId: schema.mediaFiles.movieId,
			episodeId: schema.mediaFiles.episodeId,
			duration: schema.mediaFiles.duration,
			isDefault: schema.mediaFiles.isDefault,
			updatedAt: schema.mediaFiles.updatedAt,
		})
		.from(schema.mediaFiles)
		.where(inArray(schema.mediaFiles.metadataId, metadataIdsJsonTable))
		.prepare(),
);

const preparedContinueWatchingBackdrops = createPreparedQuery((client: PlaybackRelationClient) =>
	client
		.select({
			metadataId: schema.metadataImages.metadataId,
			imageId: schema.images.id,
			imageUpdatedAt: schema.images.updatedAt,
		})
		.from(schema.metadataImages)
		.innerJoin(schema.images, metadataImageOn)
		.where(and(inArray(schema.metadataImages.metadataId, metadataIdsJsonTable), eq(schema.metadataImages.imageType, "backdrop")))
		.prepare(),
);

/** Titles of the profile's most recently played files, with the data the continue-watching cards need. */
export async function findContinueWatchingData(profileId: string, limit = 24) {
	const client = databaseFactory.getClient();
	const fetchLimit = Math.max(50, limit * 4);
	const progressRows = await preparedContinueWatchingProgress(client).execute({ profileId, fetchLimit });

	if (progressRows.length === 0) {
		return { progressRows: [], metadataList: [], mediaFiles: [], seasons: [], episodes: [], backdrops: [] };
	}

	const maxMetadataIds = Math.max(20, limit * 2);
	const seen = new Set<string>();
	const metadataIds: string[] = [];
	for (const p of progressRows) {
		if (seen.has(p.metadataId)) continue;

		seen.add(p.metadataId);
		metadataIds.push(p.metadataId);
		if (metadataIds.length >= maxMetadataIds) break;
	}

	const ids = JSON.stringify(metadataIds);
	const [metadataList, mediaFiles, seasonsAndEpisodes, backdrops] = await Promise.all([
		preparedContinueWatchingMetadata(client).execute({ ids }),
		preparedContinueWatchingMediaFiles(client).execute({ ids }),
		findSeasonsAndEpisodes(metadataIds, { regularOnly: true }),
		preparedContinueWatchingBackdrops(client).execute({ ids }),
	]);

	return {
		progressRows,
		metadataList,
		mediaFiles,
		seasons: seasonsAndEpisodes.seasons,
		episodes: seasonsAndEpisodes.episodes,
		backdrops,
	};
}
