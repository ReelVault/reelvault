import { and, count, desc, eq, exists, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { mapChunked } from "@/database/table-access";
import { serverConfig } from "@/server.config";
import { DAY } from "@/server.constants";

class DiscoverRepository {
	async findRecommendationCandidates(profileId: string, limit = serverConfig.application.discoverCandidateLimit) {
		const client = databaseFactory.getClient();
		const [rawWatched, rawRatings, rawWatchlist, catalog] = await Promise.all([
			client
				.select({ metadataId: schema.mediaFiles.metadataId, watchCount: count() })
				.from(schema.watchedHistory)
				.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
				.where(and(eq(schema.watchedHistory.profileId, profileId), isNotNull(schema.mediaFiles.metadataId)))
				.groupBy(schema.mediaFiles.metadataId),
			client
				.select({ metadataId: schema.userRatings.metadataId, rating: sql<number>`max(${schema.userRatings.rating})`.mapWith(Number) })
				.from(schema.userRatings)
				.where(and(eq(schema.userRatings.profileId, profileId), isNotNull(schema.userRatings.metadataId)))
				.groupBy(schema.userRatings.metadataId),
			client
				.select({
					metadataId: schema.watchlist.metadataId,
					createdAt: schema.watchlist.createdAt,
				})
				.from(schema.watchlist)
				.where(and(eq(schema.watchlist.profileId, profileId), isNotNull(schema.watchlist.metadataId)))
				.groupBy(schema.watchlist.metadataId),
			client
				.select({
					id: schema.metadata.id,
					stableKey: schema.metadata.stableKey,
					primaryProviderId: schema.metadata.primaryProviderId,
					title: schema.metadata.title,
					originalTitle: schema.metadata.originalTitle,
					overview: schema.metadata.overview,
					tagline: schema.metadata.tagline,
					type: schema.metadata.type,
					status: schema.metadata.status,
					releaseDate: schema.metadata.releaseDate,
					originCountry: schema.metadata.originCountry,
					budget: schema.metadata.budget,
					revenue: schema.metadata.revenue,
					popularity: schema.metadata.popularity,
					matchScore: schema.metadata.matchScore,
					hasMissingTranslation: schema.metadata.hasMissingTranslation,
					createdAt: schema.metadata.createdAt,
					updatedAt: schema.metadata.updatedAt,
				})
				.from(schema.metadata)
				.where(exists(client.select({ one: sql`1` }).from(schema.mediaFiles).where(eq(schema.mediaFiles.metadataId, schema.metadata.id))))
				.orderBy(desc(schema.metadata.popularity), desc(schema.metadata.createdAt))
				.limit(limit),
		]);

		const watched = rawWatched.filter((w): w is { metadataId: string; watchCount: number } => Boolean(w.metadataId));
		const ratings = rawRatings.filter((r): r is { metadataId: string; rating: number } => Boolean(r.metadataId));
		const watchlist = rawWatchlist.filter((wl): wl is { metadataId: string; createdAt: Date } => Boolean(wl.metadataId));

		return { watched, ratings, watchlist, catalog };
	}

	/**
	 * Fetches the best completion signal per metadata item for a profile.
	 * Uses playback_progress (position/duration/completed) joined through media_files.
	 * Returns one row per metadataId: the highest completion ratio seen across all media files
	 * for that metadata, and whether any file was ever marked completed.
	 * Also returns updatedAt as the proxy for "last engaged with this title".
	 */
	async findPlaybackCompletionSignals(profileId: string) {
		const client = databaseFactory.getClient();
		const rows = await client
			.select({
				metadataId: schema.mediaFiles.metadataId,
				// Best completion ratio across all media files for this metadata
				bestCompletionRatio: sql<number>`max(
					case
						when ${schema.playbackProgress.duration} > 0
						then cast(${schema.playbackProgress.position} as real) / ${schema.playbackProgress.duration}
						else 0
					end
				)`.mapWith(Number),
				// Whether any file was fully completed
				anyCompleted: sql<boolean>`max(case when ${schema.playbackProgress.completed} then 1 else 0 end) > 0`.mapWith(Boolean),
				// Most recent engagement with this title
				lastEngagedAt: sql<number>`max(unixepoch(${schema.playbackProgress.updatedAt}))`.mapWith(Number),
			})
			.from(schema.playbackProgress)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.playbackProgress.mediaFileId))
			.where(and(eq(schema.playbackProgress.profileId, profileId), isNotNull(schema.mediaFiles.metadataId)))
			.groupBy(schema.mediaFiles.metadataId);

		return rows.filter((r): r is { metadataId: string; bestCompletionRatio: number; anyCompleted: boolean; lastEngagedAt: number } =>
			Boolean(r.metadataId),
		);
	}

	/**
	 * Global trending: metadata items that have been watched most across ALL profiles
	 * in the last `days` days. Used for the trending section (same for every profile).
	 * Returns metadataId + playCount sorted descending.
	 */
	async findRecentlyWatchedByOthers(days = 14, limit = 100) {
		const client = databaseFactory.getClient();
		const since = new Date(Date.now() - days * DAY);

		return await client
			.select({
				metadataId: schema.mediaFiles.metadataId,
				playCount: count(schema.watchedHistory.id),
			})
			.from(schema.watchedHistory)
			.innerJoin(schema.mediaFiles, eq(schema.mediaFiles.id, schema.watchedHistory.mediaFileId))
			.where(and(isNotNull(schema.mediaFiles.metadataId), gte(schema.watchedHistory.watchedAt, since)))
			.groupBy(schema.mediaFiles.metadataId)
			.orderBy(desc(count(schema.watchedHistory.id)))
			.limit(limit);
	}

	async findMetadataGenres(metadataIds: string[]) {
		return await this.findMetadataRelation(metadataIds, (ids) =>
			databaseFactory
				.getClient()
				.select({ metadataId: schema.metadataGenres.metadataId, relId: schema.metadataGenres.genreId })
				.from(schema.metadataGenres)
				.where(inArray(schema.metadataGenres.metadataId, ids)),
		);
	}

	/**
	 * Top-3 cast members per metadata item for actor affinity scoring.
	 * sortOrder <= 2 = top-billed actors (0-indexed, from provider data).
	 */
	async findMetadataCast(metadataIds: string[]) {
		return await this.findMetadataRelation(metadataIds, (ids) =>
			databaseFactory
				.getClient()
				.select({ metadataId: schema.metadataCast.metadataId, relId: schema.metadataCast.personId })
				.from(schema.metadataCast)
				.where(and(inArray(schema.metadataCast.metadataId, ids), lte(schema.metadataCast.sortOrder, 2))),
		);
	}

	/** Keywords for content-based similarity scoring. */
	async findMetadataKeywords(metadataIds: string[]) {
		return await this.findMetadataRelation(metadataIds, (ids) =>
			databaseFactory
				.getClient()
				.select({ metadataId: schema.metadataKeywords.metadataId, relId: schema.metadataKeywords.keywordId })
				.from(schema.metadataKeywords)
				.where(inArray(schema.metadataKeywords.metadataId, ids)),
		);
	}

	/** Chunked, concurrent helper for all metadataId→relId junction table queries. */
	private async findMetadataRelation(
		metadataIds: string[],
		query: (ids: string[]) => Promise<Array<{ metadataId: string | null; relId: string }>>,
	): Promise<Array<{ metadataId: string; relId: string }>> {
		const validIds = metadataIds.filter((id): id is string => Boolean(id));
		if (validIds.length === 0) return [];

		const rows = await mapChunked(validIds, query, { concurrency: serverConfig.database.relationQueryConcurrency });

		return rows.filter((r): r is { metadataId: string; relId: string } => Boolean(r.metadataId));
	}
}

export const discoverRepository = new DiscoverRepository();
