import type { MetadataType } from "@sdk/common/metadata.types";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";
import { metadataRepository } from "./metadata.repository";

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

		const [seasons, episodes] = await Promise.all([
			client
				.select({ id: schema.seasons.id, seasonNumber: schema.seasons.seasonNumber })
				.from(schema.seasons)
				.where(eq(schema.seasons.metadataId, metadataId)),
			client
				.select({
					id: schema.episodes.id,
					seasonId: schema.episodes.seasonId,
					episodeNumber: schema.episodes.episodeNumber,
					absoluteNumber: schema.episodes.absoluteNumber,
					episodeType: schema.episodes.episodeType,
				})
				.from(schema.episodes)
				.innerJoin(schema.seasons, eq(schema.seasons.id, schema.episodes.seasonId))
				.where(eq(schema.seasons.metadataId, metadataId)),
		]);

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

	async findProgressUpdateData(fileId: string, profileId: string) {
		const client = databaseFactory.getClient();
		const row = await client
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
				and(eq(schema.playbackProgress.mediaFileId, schema.mediaFiles.id), eq(schema.playbackProgress.profileId, profileId)),
			)
			.where(eq(schema.mediaFiles.id, fileId))
			.limit(1)
			.then((rows) => rows[0]);

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
		const updateValues: Record<string, unknown> = { position, duration, completed, updatedAt: new Date() };
		if (audioStreamIndex !== undefined) updateValues.audioStreamIndex = audioStreamIndex;

		if (subtitleId !== undefined) updateValues.subtitleId = subtitleId;

		await databaseFactory
			.getClient({ tx })
			.insert(schema.playbackProgress)
			.values({
				profileId,
				mediaFileId: fileId,
				position,
				duration,
				completed,
				audioStreamIndex: audioStreamIndex ?? null,
				subtitleId: subtitleId ?? null,
			})
			.onConflictDoUpdate({
				target: [schema.playbackProgress.profileId, schema.playbackProgress.mediaFileId],
				set: updateValues,
			});
	}

	async deleteProgress(profileId: string, fileId: string, tx?: DatabaseTransaction) {
		await databaseFactory
			.getClient({ tx })
			.delete(schema.playbackProgress)
			.where(and(eq(schema.playbackProgress.profileId, profileId), eq(schema.playbackProgress.mediaFileId, fileId)));
	}

	async findMediaFileWithMetadata(fileId: string) {
		return await databaseFactory
			.getClient()
			.select({
				id: schema.mediaFiles.id,
				metadataId: schema.mediaFiles.metadataId,
				movieId: schema.mediaFiles.movieId,
				episodeId: schema.mediaFiles.episodeId,
			})
			.from(schema.mediaFiles)
			.where(eq(schema.mediaFiles.id, fileId))
			.limit(1)
			.then((rows) => rows[0]);
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

		const [metadataList, mediaFiles, seasons, episodes, backdrops] = await Promise.all([
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
			client
				.select({
					id: schema.seasons.id,
					metadataId: schema.seasons.metadataId,
					seasonNumber: schema.seasons.seasonNumber,
				})
				.from(schema.seasons)
				.where(inArray(schema.seasons.metadataId, metadataIds)),
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
				.where(and(inArray(schema.seasons.metadataId, metadataIds), eq(schema.episodes.episodeType, "regular"))),
			client
				.select({
					metadataId: schema.metadataImages.metadataId,
					imageId: schema.images.id,
					imageUpdatedAt: schema.images.updatedAt,
				})
				.from(schema.metadataImages)
				.innerJoin(schema.images, eq(schema.images.id, schema.metadataImages.imageId))
				.where(and(inArray(schema.metadataImages.metadataId, metadataIds), eq(schema.metadataImages.imageType, "backdrop"))),
		]);

		return { progressRows, metadataList, mediaFiles, seasons, episodes, backdrops };
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
