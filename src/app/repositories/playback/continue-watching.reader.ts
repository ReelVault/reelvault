import { desc, eq, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import { metadataImageOn } from "@/integrations/drizzle-orm/utils/join-conditions.utils";
import {
	booleanKeysOf,
	dateKeysOf,
	parseJsonRelationArray,
	type RelationJsonKeys,
	relationJsonArrayOver,
} from "@/integrations/drizzle-orm/utils/relation-json.utils";
import {
	type EpisodeRow,
	episodeKeys,
	metadataIdsJsonTable,
	noRevive,
	type PlaybackRelationClient,
	type SeasonRow,
	seasonKeys,
	seasonsAndEpisodesJson,
} from "./seasons.reader";

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

const metadataColumns = {
	id: schema.metadata.id,
	title: schema.metadata.title,
	type: schema.metadata.type,
};

const fileColumns = {
	id: schema.mediaFiles.id,
	metadataId: schema.mediaFiles.metadataId,
	movieId: schema.mediaFiles.movieId,
	episodeId: schema.mediaFiles.episodeId,
	duration: schema.mediaFiles.duration,
	isDefault: schema.mediaFiles.isDefault,
	updatedAt: schema.mediaFiles.updatedAt,
};

const backdropColumns = {
	metadataId: schema.metadataImages.metadataId,
	imageId: schema.images.id,
	imageUpdatedAt: schema.images.updatedAt,
};

export type ContinueWatchingMetadata = Pick<typeof schema.metadata.$inferSelect, "id" | "title" | "type">;
export type ContinueWatchingFile = Pick<
	typeof schema.mediaFiles.$inferSelect,
	"id" | "metadataId" | "movieId" | "episodeId" | "duration" | "isDefault" | "updatedAt"
>;
export interface ContinueWatchingBackdrop {
	metadataId: typeof schema.metadataImages.$inferSelect.metadataId;
	imageId: typeof schema.images.$inferSelect.id;
	imageUpdatedAt: typeof schema.images.$inferSelect.updatedAt;
}

const metadataKeys = Object.keys(metadataColumns);
const fileKeys = Object.keys(fileColumns);
const backdropKeys = Object.keys(backdropColumns);
const fileRevive: RelationJsonKeys = { booleanKeys: booleanKeysOf(fileColumns), dateKeys: dateKeysOf(fileColumns) };
const backdropRevive: RelationJsonKeys = { booleanKeys: booleanKeysOf(backdropColumns), dateKeys: dateKeysOf(backdropColumns) };

/**
 * The continue-watching dependent reads — title rows, media files, regular
 * seasons/episodes and backdrops — are keyed by the same metadata id list, so
 * they come back as JSON columns of one statement (four round trips → one).
 * The arrays carry the columns the old statements returned; timestamps and the
 * file's `isDefault` flag are revived after parsing.
 */
const preparedContinueWatchingDetails = createPreparedQuery((client: PlaybackRelationClient) =>
	client
		.select({
			metadataList: relationJsonArrayOver(metadataColumns, sql`${schema.metadata} WHERE ${schema.metadata.id} IN ${metadataIdsJsonTable}`),
			mediaFiles: relationJsonArrayOver(
				fileColumns,
				sql`${schema.mediaFiles} WHERE ${schema.mediaFiles.metadataId} IN ${metadataIdsJsonTable}`,
			),
			...seasonsAndEpisodesJson(sql`IN ${metadataIdsJsonTable}`, true),
			backdrops: relationJsonArrayOver(
				backdropColumns,
				sql`${schema.metadataImages} JOIN ${schema.images} ON ${metadataImageOn} WHERE ${schema.metadataImages.metadataId} IN ${metadataIdsJsonTable} AND ${schema.metadataImages.imageType} = 'backdrop'`,
			),
		})
		.from(sql`(SELECT 1)`)
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

	const [details] = await preparedContinueWatchingDetails(client).execute({ ids: JSON.stringify(metadataIds) });

	return {
		progressRows,
		metadataList: details ? parseJsonRelationArray<ContinueWatchingMetadata>(details.metadataList, metadataKeys, noRevive) : [],
		mediaFiles: details ? parseJsonRelationArray<ContinueWatchingFile>(details.mediaFiles, fileKeys, fileRevive) : [],
		seasons: details ? parseJsonRelationArray<SeasonRow>(details.seasons, seasonKeys, noRevive) : [],
		episodes: details ? parseJsonRelationArray<EpisodeRow>(details.episodes, episodeKeys, noRevive) : [],
		backdrops: details ? parseJsonRelationArray<ContinueWatchingBackdrop>(details.backdrops, backdropKeys, backdropRevive) : [],
	};
}
