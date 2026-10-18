import type { MetadataType } from "@reelvault/sdk/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { metadataRepository } from "@/app/repositories/metadata.repository";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { createPreparedQuery } from "@/integrations/drizzle-orm/query/prepared-queries.utils";
import { groupBy, toMap } from "@/utils/array.utils";
import { findSeasonsAndEpisodes, type PlaybackRelationClient } from "./seasons.reader";

/**
 * Fixed-shape reads of the playback view and grid paths: prepared once per
 * connection instead of rebuilt for every progress view, smart-play read and
 * continue-watching page.
 */
const preparedProgressRows = createPreparedQuery((client: PlaybackRelationClient) =>
	client
		.select({
			mediaFileId: schema.playbackProgress.mediaFileId,
			episodeId: schema.mediaFiles.episodeId,
			movieId: schema.mediaFiles.movieId,
			position: schema.playbackProgress.position,
			duration: schema.playbackProgress.duration,
			completed: schema.playbackProgress.completed,
			audioStreamIndex: schema.playbackProgress.audioStreamIndex,
			subtitleId: schema.playbackProgress.subtitleId,
			updatedAt: schema.playbackProgress.updatedAt,
		})
		.from(schema.playbackProgress)
		.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.playbackProgress.mediaFileId))
		.where(
			and(
				eq(schema.playbackProgress.profileId, sql.placeholder("profileId")),
				eq(schema.mediaFiles.metadataId, sql.placeholder("metadataId")),
			),
		)
		// Newest first: movie smart-play resumes the first row, so the order must be explicit.
		.orderBy(desc(schema.playbackProgress.updatedAt))
		.prepare(),
);

const preparedSmartPlayMediaFiles = createPreparedQuery((client: PlaybackRelationClient) =>
	client
		.select({
			id: schema.mediaFiles.id,
			movieId: schema.mediaFiles.movieId,
			episodeId: schema.mediaFiles.episodeId,
			isDefault: schema.mediaFiles.isDefault,
			updatedAt: schema.mediaFiles.updatedAt,
		})
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.metadataId, sql.placeholder("metadataId")))
		.prepare(),
);

export async function findProgressRows(metadataId: string, profileId: string) {
	return await preparedProgressRows(databaseFactory.getClient()).execute({ metadataId, profileId });
}

/** Numbering mode always comes from the row: smart-play ordering depends on it. */
async function metadataTypeFor(metadataType: MetadataType | undefined, metadataId: string) {
	if (metadataType === "movie") {
		return { type: "movie", numberingMode: null };
	}

	if (metadataType) {
		return await metadataRepository
			.findNumberingModeById(metadataId)
			.then((row) => ({ type: metadataType, numberingMode: row?.numberingMode ?? null }));
	}

	return metadataRepository.findTypeById(metadataId);
}

/**
 * Smart-play source data of one title: its media files, the profile's progress and, for series, the
 * seasons and episodes. Callers that already hold the metadata row pass its type to skip re-reading it.
 */
export async function findPlaybackProgressAndSmartPlayData(metadataId: string, profileId: string, metadataType?: MetadataType) {
	const client = databaseFactory.getClient();
	const [metadata, mediaFiles, progressRows] = await Promise.all([
		metadataTypeFor(metadataType, metadataId),
		preparedSmartPlayMediaFiles(client).execute({ metadataId }),
		findProgressRows(metadataId, profileId),
	]);

	if (!metadata) return null;

	if (metadata.type === "movie") {
		return { metadata, mediaFiles, progressRows, seasons: [], episodes: [] };
	}

	const { seasons, episodes } = await findSeasonsAndEpisodes([metadataId]);

	return { metadata, mediaFiles, progressRows, seasons, episodes };
}

export async function findSmartPlayData(metadataId: string, profileId: string) {
	const data = await findPlaybackProgressAndSmartPlayData(metadataId, profileId);
	if (!data) return null;

	return {
		metadata: data.metadata,
		mediaFiles: data.mediaFiles,
		progress: data.progressRows,
		seasons: data.seasons,
		episodes: data.episodes.filter((ep) => ep.episodeType === "regular"),
	};
}

/**
 * Batched smart-play source data for a card grid (bounded id list, ≤50):
 * one metadata read, one media-file read, one progress read and — only when
 * the batch contains series — one seasons+episodes read for the whole list.
 * Replaces the per-id `findSmartPlayData` fan-out (3-5 statements per id).
 */
export async function findSmartPlayBatchData(metadataIds: readonly string[], profileId: string) {
	if (metadataIds.length === 0) return [];

	const client = databaseFactory.getClient();
	const ids = [...metadataIds];
	const metadataRows = await client
		.select({ id: schema.metadata.id, type: schema.metadata.type, numberingMode: schema.metadata.numberingMode })
		.from(schema.metadata)
		.where(inArray(schema.metadata.id, ids));
	const metadataById = toMap(metadataRows, (row) => row.id);
	const seriesIds = metadataRows.filter((row) => row.type !== "movie").map((row) => row.id);

	const [mediaFiles, progressRows, seasonsAndEpisodes] = await Promise.all([
		client
			.select({
				id: schema.mediaFiles.id,
				metadataId: schema.mediaFiles.metadataId,
				movieId: schema.mediaFiles.movieId,
				episodeId: schema.mediaFiles.episodeId,
				isDefault: schema.mediaFiles.isDefault,
				updatedAt: schema.mediaFiles.updatedAt,
			})
			.from(schema.mediaFiles)
			.where(inArray(schema.mediaFiles.metadataId, ids)),
		client
			.select({
				metadataId: schema.mediaFiles.metadataId,
				mediaFileId: schema.playbackProgress.mediaFileId,
				episodeId: schema.mediaFiles.episodeId,
				movieId: schema.mediaFiles.movieId,
				position: schema.playbackProgress.position,
				duration: schema.playbackProgress.duration,
				completed: schema.playbackProgress.completed,
				audioStreamIndex: schema.playbackProgress.audioStreamIndex,
				subtitleId: schema.playbackProgress.subtitleId,
				updatedAt: schema.playbackProgress.updatedAt,
			})
			.from(schema.playbackProgress)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.playbackProgress.mediaFileId))
			.where(and(eq(schema.playbackProgress.profileId, profileId), inArray(schema.mediaFiles.metadataId, ids))),
		seriesIds.length > 0 ? findSeasonsAndEpisodes(seriesIds) : Promise.resolve({ seasons: [], episodes: [] }),
	]);

	const mediaFilesByMetadataId = groupBy(mediaFiles, (file) => file.metadataId);
	const progressByMetadataId = groupBy(progressRows, (progress) => progress.metadataId);
	const seasonMetadataId = toMap(
		seasonsAndEpisodes.seasons,
		(season) => season.id,
		(season) => season.metadataId,
	);

	return ids.map((metadataId) => {
		const metadata = metadataById.get(metadataId);
		if (!metadata) return { metadataId, data: null };

		return {
			metadataId,
			data: {
				metadata: { type: metadata.type, numberingMode: metadata.numberingMode },
				mediaFiles: mediaFilesByMetadataId.get(metadataId) ?? [],
				progressRows: progressByMetadataId.get(metadataId) ?? [],
				seasons: seasonsAndEpisodes.seasons.filter((season) => season.metadataId === metadataId),
				episodes: seasonsAndEpisodes.episodes.filter(
					(episode) => episode.episodeType === "regular" && seasonMetadataId.get(episode.seasonId) === metadataId,
				),
			},
		};
	});
}
