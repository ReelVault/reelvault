import type { MetadataType } from "@reelvault/sdk/common";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { databaseFactory } from "@/database/database";
import { createPreparedQuery } from "@/database/prepared-queries";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";
import { metadataImageOn } from "@/database/utils/join-conditions";
import { groupBy, toMap } from "@/utils/array.utils";
import { metadataRepository } from "./metadata.repository";

/**
 * Fixed-shape playback queries (Faza 3 pilot). Inserts bind `id`/timestamps
 * explicitly because `$defaultFn` values freeze at `prepare()` time.
 */
const preparedFindProgressUpdateData = createPreparedQuery((client) =>
	client
		.select({
			id: schema.mediaFiles.id,
			duration: schema.mediaFiles.duration,
			metadataId: schema.mediaFiles.metadataId,
			completed: schema.playbackProgress.completed,
			position: schema.playbackProgress.position,
			audioStreamIndex: schema.playbackProgress.audioStreamIndex,
			subtitleId: schema.playbackProgress.subtitleId,
		})
		.from(schema.mediaFiles)
		.leftJoin(
			schema.playbackProgress,
			and(
				eq(schema.playbackProgress.mediaFileId, schema.mediaFiles.id),
				eq(schema.playbackProgress.profileId, sql.placeholder("profileId")),
			),
		)
		.where(eq(schema.mediaFiles.id, sql.placeholder("fileId")))
		.limit(1)
		.prepare(),
);

const preparedFindMediaFileWithMetadata = createPreparedQuery((client) =>
	client
		.select({
			id: schema.mediaFiles.id,
			metadataId: schema.mediaFiles.metadataId,
			movieId: schema.mediaFiles.movieId,
			episodeId: schema.mediaFiles.episodeId,
		})
		.from(schema.mediaFiles)
		.where(eq(schema.mediaFiles.id, sql.placeholder("fileId")))
		.limit(1)
		.prepare(),
);

function buildUpsertProgress(client: DatabaseTransaction, withAudio: boolean, withSubtitle: boolean) {
	const updateSet = {
		position: sql.placeholder("position"),
		duration: sql.placeholder("duration"),
		completed: sql.placeholder("completed"),
		updatedAt: sql.placeholder("updatedAt"),
		...(withAudio ? { audioStreamIndex: sql.placeholder("audioStreamIndex") } : {}),
		...(withSubtitle ? { subtitleId: sql.placeholder("subtitleId") } : {}),
	};

	return client
		.insert(schema.playbackProgress)
		.values({
			id: sql.placeholder("id"),
			profileId: sql.placeholder("profileId"),
			mediaFileId: sql.placeholder("fileId"),
			position: sql.placeholder("position"),
			duration: sql.placeholder("duration"),
			completed: sql.placeholder("completed"),
			audioStreamIndex: sql.placeholder("audioStreamIndex"),
			subtitleId: sql.placeholder("subtitleId"),
			createdAt: sql.placeholder("createdAt"),
			updatedAt: sql.placeholder("updatedAt"),
		})
		.onConflictDoUpdate({
			target: [schema.playbackProgress.profileId, schema.playbackProgress.mediaFileId],
			set: updateSet,
		})
		.prepare();
}

const preparedUpsertProgress = {
	audioSubtitle: createPreparedQuery((client) => buildUpsertProgress(client, true, true)),
	audio: createPreparedQuery((client) => buildUpsertProgress(client, true, false)),
	subtitle: createPreparedQuery((client) => buildUpsertProgress(client, false, true)),
	none: createPreparedQuery((client) => buildUpsertProgress(client, false, false)),
};

function selectUpsertProgressPrepared(hasAudio: boolean, hasSubtitle: boolean) {
	if (hasAudio && hasSubtitle) return preparedUpsertProgress.audioSubtitle;

	if (hasAudio) return preparedUpsertProgress.audio;

	if (hasSubtitle) return preparedUpsertProgress.subtitle;

	return preparedUpsertProgress.none;
}

class PlaybackRepository {
	/** Distinct profiles that have watched any file of this metadata row. */
	async findViewerProfilesByMetadataId(metadataId: string): Promise<Array<{ profileId: string; userId: string }>> {
		return await databaseFactory
			.getClient()
			.select({ profileId: schema.playbackProgress.profileId, userId: schema.profiles.userId })
			.from(schema.playbackProgress)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.playbackProgress.mediaFileId))
			.innerJoin(schema.profiles, eq(schema.profiles.id, schema.playbackProgress.profileId))
			.where(eq(schema.mediaFiles.metadataId, metadataId));
	}

	async findProgressRows(metadataId: string, profileId: string) {
		const client = databaseFactory.getClient();

		return await client
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
			.where(and(eq(schema.playbackProgress.profileId, profileId), eq(schema.mediaFiles.metadataId, metadataId)));
	}

	async findPlaybackProgressAndSmartPlayData(metadataId: string, profileId: string, metadataType?: MetadataType) {
		const client = databaseFactory.getClient();
		// Callers that already hold the metadata row pass its type here — saves
		// re-reading the row on every playback start / progress view. Numbering
		// mode always comes from the row: smart-play ordering depends on it.
		const [metadata, mediaFiles, progressRows] = await Promise.all([
			metadataTypeFor(metadataType, metadataId),
			client
				.select({
					id: schema.mediaFiles.id,
					movieId: schema.mediaFiles.movieId,
					episodeId: schema.mediaFiles.episodeId,
					isDefault: schema.mediaFiles.isDefault,
					updatedAt: schema.mediaFiles.updatedAt,
				})
				.from(schema.mediaFiles)
				.where(eq(schema.mediaFiles.metadataId, metadataId)),
			this.findProgressRows(metadataId, profileId),
		]);

		if (!metadata) return null;

		if (metadata.type === "movie") {
			return { metadata, mediaFiles, progressRows, seasons: [], episodes: [] };
		}

		const { seasons, episodes } = await this.findSeasonsAndEpisodes([metadataId]);

		return { metadata, mediaFiles, progressRows, seasons, episodes };
	}

	async findSmartPlayData(metadataId: string, profileId: string) {
		const data = await this.findPlaybackProgressAndSmartPlayData(metadataId, profileId);
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
	async findSmartPlayBatchData(metadataIds: readonly string[], profileId: string) {
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
			seriesIds.length > 0 ? this.findSeasonsAndEpisodes(seriesIds) : Promise.resolve({ seasons: [], episodes: [] }),
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

	/**
	 * Seasons + episodes of the given titles. `regularOnly` drops specials,
	 * which the continue-watching view does not surface.
	 */
	private async findSeasonsAndEpisodes(metadataIds: readonly string[], options?: { regularOnly?: boolean; tx?: DatabaseTransaction }) {
		const client = databaseFactory.getClient({ tx: options?.tx });
		const metadataIdFilter = inArray(schema.seasons.metadataId, [...metadataIds]);

		const [seasons, episodes] = await Promise.all([
			client
				.select({
					id: schema.seasons.id,
					metadataId: schema.seasons.metadataId,
					seasonNumber: schema.seasons.seasonNumber,
				})
				.from(schema.seasons)
				.where(metadataIdFilter),
			client
				.select({
					id: schema.episodes.id,
					seasonId: schema.episodes.seasonId,
					episodeNumber: schema.episodes.episodeNumber,
					absoluteNumber: schema.episodes.absoluteNumber,
					title: schema.episodes.title,
					episodeType: schema.episodes.episodeType,
				})
				.from(schema.episodes)
				.innerJoin(schema.seasons, eq(schema.seasons.id, schema.episodes.seasonId))
				.where(options?.regularOnly ? and(metadataIdFilter, eq(schema.episodes.episodeType, "regular")) : metadataIdFilter),
		]);

		return { seasons, episodes };
	}

	async findProgressUpdateData(fileId: string, profileId: string) {
		const [row] = await preparedFindProgressUpdateData(databaseFactory.getClient()).execute({ fileId, profileId });

		if (!row) {
			return { mediaFile: undefined, existingProgress: undefined };
		}

		return {
			mediaFile: { id: row.id, duration: row.duration, metadataId: row.metadataId },
			existingProgress:
				row.completed != null
					? {
							completed: row.completed,
							position: row.position,
							audioStreamIndex: row.audioStreamIndex,
							subtitleId: row.subtitleId,
						}
					: undefined,
		};
	}

	/** Whether any in-progress (not completed, position past `minPositionSeconds`) file of this title has watched progress. */
	async hasActiveTitleProgress(profileId: string, metadataId: string, minPositionSeconds: number): Promise<boolean> {
		const client = databaseFactory.getClient();
		const row = await client
			.select({ id: schema.playbackProgress.mediaFileId })
			.from(schema.playbackProgress)
			.innerJoin(schema.mediaFiles, eq(schema.playbackProgress.mediaFileId, schema.mediaFiles.id))
			.where(
				and(
					eq(schema.playbackProgress.profileId, profileId),
					eq(schema.mediaFiles.metadataId, metadataId),
					eq(schema.playbackProgress.completed, false),
					gte(schema.playbackProgress.position, minPositionSeconds),
				),
			)
			.limit(1)
			.then((rows) => rows[0]);

		return row !== undefined;
	}

	async upsertProgress({
		profileId,
		fileId,
		position,
		duration,
		completed,
		audioStreamIndex,
		subtitleId,
		tx,
	}: {
		profileId: string;
		fileId: string;
		position: number;
		duration: number;
		completed: boolean;
		audioStreamIndex?: number | null | undefined;
		subtitleId?: string | null | undefined;
		tx?: DatabaseTransaction | undefined;
	}) {
		const now = new Date();
		const prepared = selectUpsertProgressPrepared(audioStreamIndex !== undefined, subtitleId !== undefined);

		await prepared(databaseFactory.getClient({ tx })).execute({
			id: uuidv7(),
			profileId,
			fileId,
			position,
			duration,
			completed,
			audioStreamIndex: audioStreamIndex ?? null,
			subtitleId: subtitleId ?? null,
			createdAt: now,
			updatedAt: now,
		});
	}

	async deleteProgress(profileId: string, fileId: string, tx?: DatabaseTransaction) {
		await databaseFactory
			.getClient({ tx })
			.delete(schema.playbackProgress)
			.where(and(eq(schema.playbackProgress.profileId, profileId), eq(schema.playbackProgress.mediaFileId, fileId)));
	}

	async findMediaFileWithMetadata(fileId: string) {
		const [row] = await preparedFindMediaFileWithMetadata(databaseFactory.getClient()).execute({ fileId });

		return row;
	}

	async deleteMetadataProgress(profileId: string, metadataId: string, tx?: DatabaseTransaction) {
		const client = databaseFactory.getClient({ tx });
		await client
			.delete(schema.playbackProgress)
			.where(
				and(
					eq(schema.playbackProgress.profileId, profileId),
					inArray(
						schema.playbackProgress.mediaFileId,
						client.select({ id: schema.mediaFiles.id }).from(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, metadataId)),
					),
				),
			);
	}

	async findContinueWatchingData(profileId: string, limit = 24) {
		const client = databaseFactory.getClient();
		const fetchLimit = Math.max(50, limit * 4);
		const progressRows = await client
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
				metadataId: schema.mediaFiles.metadataId,
				movieId: schema.mediaFiles.movieId,
				episodeId: schema.mediaFiles.episodeId,
			})
			.from(schema.playbackProgress)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.playbackProgress.mediaFileId))
			.where(eq(schema.playbackProgress.profileId, profileId))
			.orderBy(desc(schema.playbackProgress.updatedAt))
			.limit(fetchLimit);

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

		const [metadataList, mediaFiles, seasonsAndEpisodes, backdrops] = await Promise.all([
			client
				.select({
					id: schema.metadata.id,
					title: schema.metadata.title,
					type: schema.metadata.type,
				})
				.from(schema.metadata)
				.where(inArray(schema.metadata.id, metadataIds)),
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
				.where(inArray(schema.mediaFiles.metadataId, metadataIds)),
			this.findSeasonsAndEpisodes(metadataIds, { regularOnly: true }),
			client
				.select({
					metadataId: schema.metadataImages.metadataId,
					imageId: schema.images.id,
					imageUpdatedAt: schema.images.updatedAt,
				})
				.from(schema.metadataImages)
				.innerJoin(schema.images, metadataImageOn)
				.where(and(inArray(schema.metadataImages.metadataId, metadataIds), eq(schema.metadataImages.imageType, "backdrop"))),
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
}

async function metadataTypeFor(metadataType: "movie" | "tv_show" | undefined, metadataId: string) {
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

export const playbackRepository = new PlaybackRepository();
