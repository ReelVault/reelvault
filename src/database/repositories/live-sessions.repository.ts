import { and, desc, eq, gt, inArray, max } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";

/**
 * Composite reads backing the admin "live activity" view. Kept out of the
 * application layer so `AdminLiveSessionsService` never touches Drizzle.
 */
class LiveSessionsRepository {
	async findMediaSummaries(mediaFileIds: readonly string[]) {
		if (mediaFileIds.length === 0) return [];

		return await databaseFactory
			.getClient()
			.select({
				mediaFileId: schema.mediaFiles.id,
				metadataId: schema.metadata.id,
				title: schema.metadata.title,
				type: schema.metadata.type,
				releaseDate: schema.metadata.releaseDate,
				duration: schema.mediaFiles.duration,
				bitRate: schema.mediaFiles.bitRate,
				posterImageId: schema.metadataImages.imageId,
				posterImageUpdatedAt: schema.images.updatedAt,
				episodeTitle: schema.episodes.title,
				episodeNumber: schema.episodes.episodeNumber,
				seasonNumber: schema.seasons.seasonNumber,
			})
			.from(schema.mediaFiles)
			.innerJoin(schema.metadata, eq(schema.metadata.id, schema.mediaFiles.metadataId))
			.leftJoin(
				schema.metadataImages,
				and(eq(schema.metadataImages.metadataId, schema.metadata.id), eq(schema.metadataImages.imageType, "poster")),
			)
			.leftJoin(schema.images, eq(schema.images.id, schema.metadataImages.imageId))
			.leftJoin(schema.episodes, eq(schema.episodes.id, schema.mediaFiles.episodeId))
			.leftJoin(schema.seasons, eq(schema.seasons.id, schema.episodes.seasonId))
			.where(inArray(schema.mediaFiles.id, [...mediaFileIds]));
	}

	async findProfilesWithUsers(profileIds: readonly string[]) {
		if (profileIds.length === 0) return [];

		return await databaseFactory
			.getClient()
			.select({
				profileId: schema.profiles.id,
				profileName: schema.profiles.name,
				profileAvatar: schema.profiles.avatarUrl,
				userId: schema.users.id,
				userName: schema.users.name,
				userEmail: schema.users.email,
			})
			.from(schema.profiles)
			.innerJoin(schema.users, eq(schema.users.id, schema.profiles.userId))
			.where(inArray(schema.profiles.id, [...profileIds]));
	}

	async findProgress(mediaFileIds: readonly string[], profileIds: readonly string[]) {
		if (mediaFileIds.length === 0 || profileIds.length === 0) return [];

		return await databaseFactory
			.getClient()
			.select({
				mediaFileId: schema.playbackProgress.mediaFileId,
				profileId: schema.playbackProgress.profileId,
				position: schema.playbackProgress.position,
				duration: schema.playbackProgress.duration,
			})
			.from(schema.playbackProgress)
			.where(
				and(inArray(schema.playbackProgress.mediaFileId, [...mediaFileIds]), inArray(schema.playbackProgress.profileId, [...profileIds])),
			);
	}

	async findVideoStreams(mediaFileIds: readonly string[]) {
		if (mediaFileIds.length === 0) return [];

		return await databaseFactory
			.getClient()
			.select()
			.from(schema.mediaFileVideoStreams)
			.where(inArray(schema.mediaFileVideoStreams.mediaFileId, [...mediaFileIds]));
	}

	async findAudioStreams(mediaFileIds: readonly string[]) {
		if (mediaFileIds.length === 0) return [];

		return await databaseFactory
			.getClient()
			.select()
			.from(schema.mediaFileAudioStreams)
			.where(inArray(schema.mediaFileAudioStreams.mediaFileId, [...mediaFileIds]));
	}

	/** Latest session per user (max updatedAt) — bare columns come from that row in SQLite. */
	async findLatestUserSessions(userIds: readonly string[]) {
		if (userIds.length === 0) return [];

		return await databaseFactory
			.getClient()
			.select({
				userId: schema.sessions.userId,
				ipAddress: schema.sessions.ipAddress,
				userAgent: schema.sessions.userAgent,
				updatedAt: max(schema.sessions.updatedAt),
			})
			.from(schema.sessions)
			.where(inArray(schema.sessions.userId, [...userIds]))
			.groupBy(schema.sessions.userId);
	}

	async findActiveUserSessions({ since, now, limit }: { since: Date; now: Date; limit: number }) {
		return await databaseFactory
			.getClient()
			.select({
				sessionId: schema.sessions.id,
				userId: schema.users.id,
				userName: schema.users.name,
				userEmail: schema.users.email,
				ipAddress: schema.sessions.ipAddress,
				userAgent: schema.sessions.userAgent,
				updatedAt: schema.sessions.updatedAt,
				createdAt: schema.sessions.createdAt,
			})
			.from(schema.sessions)
			.innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
			.where(and(gt(schema.sessions.expiresAt, now), gt(schema.sessions.updatedAt, since)))
			.orderBy(desc(schema.sessions.updatedAt))
			.limit(limit);
	}
}

export const liveSessionsRepository = new LiveSessionsRepository();
