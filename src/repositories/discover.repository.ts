import { and, count, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { DAY, serverConstants } from "@/config/server/server.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";

class DiscoverRepository {
	async findRecommendationCandidates(profileId: string, limit = serverConstants.application.discoverCandidateLimit) {
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
					popularity: schema.metadata.popularity,
					createdAt: schema.metadata.createdAt,
				})
				.from(schema.metadata)
				.where(isNotNull(schema.metadata.latestMediaCreatedAt))
				.orderBy(desc(schema.metadata.popularity), desc(schema.metadata.createdAt))
				.limit(limit),
		]);

		const watched = rawWatched.filter((w): w is { metadataId: string; watchCount: number } => Boolean(w.metadataId));
		const ratings = rawRatings.filter((r): r is { metadataId: string; rating: number } => Boolean(r.metadataId));
		const watchlist = rawWatchlist.filter((wl): wl is { metadataId: string; createdAt: Date } => Boolean(wl.metadataId));

		return { watched, ratings, watchlist, catalog };
	}

	/** Metadata ids the profile rated as "not interested" (0 = dislike). Excluded from recommendations and trending. */
	async findDislikedMetadataIds(profileId: string): Promise<string[]> {
		const rows = await databaseFactory
			.getClient()
			.select({ metadataId: schema.userRatings.metadataId })
			.from(schema.userRatings)
			.where(and(eq(schema.userRatings.profileId, profileId), eq(schema.userRatings.rating, 0), isNotNull(schema.userRatings.metadataId)));

		return rows.map((row) => row.metadataId).filter((id): id is string => Boolean(id));
	}

	/**
	 * Fetches the best completion signal per metadata item for a profile.	 * Uses playback_progress (position/duration/completed) joined through media_files.
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

	/**
	 * Genres, keywords and top-3 billed cast in one statement. The id list rides
	 * a single JSON parameter, so a large profile cannot hit SQLite's bound-
	 * variable limit and the service does not pay three round trips.
	 */
	findMetadataRelations(metadataIds: string[]): Array<{ kind: "genre" | "keyword" | "cast"; metadataId: string; relId: string }> {
		const validIds = metadataIds.filter((id): id is string => Boolean(id));
		if (validIds.length === 0) return [];

		const idsJson = JSON.stringify(validIds);
		const rows = databaseFactory.getClient().all<{
			kind: "genre" | "keyword" | "cast";
			metadataId: string;
			relId: string;
		}>(sql`
			SELECT 'genre' AS kind, metadata_id AS metadataId, genre_id AS relId
			FROM ${schema.metadataGenres}
			WHERE metadata_id IN (SELECT value FROM json_each(${idsJson}))
			UNION ALL
			SELECT 'keyword' AS kind, metadata_id AS metadataId, keyword_id AS relId
			FROM ${schema.metadataKeywords}
			WHERE metadata_id IN (SELECT value FROM json_each(${idsJson}))
			UNION ALL
			SELECT 'cast' AS kind, metadata_id AS metadataId, person_id AS relId
			FROM ${schema.metadataCast}
			WHERE metadata_id IN (SELECT value FROM json_each(${idsJson})) AND sort_order <= 2
		`);

		return rows.filter((row) => Boolean(row.metadataId));
	}
}

export const discoverRepository = new DiscoverRepository();
