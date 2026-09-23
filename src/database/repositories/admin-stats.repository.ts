import { sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import { LOW_CONFIDENCE_MATCH_SCORE } from "@/server.constants";

/** Aggregate counts backing the admin dashboard stats card. */
class AdminStatsRepository {
	async getMediaStats() {
		const [row] = await databaseFactory
			.getClient()
			.select({
				totalFiles: sql<number>`count(*)`,
				totalSize: sql<number>`coalesce(sum(${schema.mediaFiles.size}), 0)`,
				moviesCount: sql<number>`count(case when ${schema.mediaFiles.movieId} is not null then 1 end)`,
				episodesCount: sql<number>`count(case when ${schema.mediaFiles.episodeId} is not null then 1 end)`,
				withQualityCount: sql<number>`count(case when ${schema.mediaFiles.qualityTag} is not null then 1 end)`,
			})
			.from(schema.mediaFiles);

		return row;
	}

	async getMetadataStats() {
		const [row] = await databaseFactory
			.getClient()
			.select({
				totalCount: sql<number>`count(*)`,
				moviesCount: sql<number>`count(case when ${schema.metadata.type} = 'movie' then 1 end)`,
				tvShowsCount: sql<number>`count(case when ${schema.metadata.type} = 'tv_show' then 1 end)`,
				lowConfidenceCount: sql<number>`count(case when ${schema.metadata.matchScore} is not null and ${schema.metadata.matchScore} < ${LOW_CONFIDENCE_MATCH_SCORE} then 1 end)`,
				missingTranslationCount: sql<number>`count(case when ${schema.metadata.hasMissingTranslation} then 1 end)`,
			})
			.from(schema.metadata);

		return row;
	}

	async getMarkerStats() {
		const [row] = await databaseFactory
			.getClient()
			.select({
				totalCount: sql<number>`count(*)`,
				introsCount: sql<number>`count(case when ${schema.mediaMarkers.type} = 'intro' then 1 end)`,
				creditsCount: sql<number>`count(case when ${schema.mediaMarkers.type} = 'credits' then 1 end)`,
				highlightsCount: sql<number>`count(case when ${schema.mediaMarkers.type} = 'highlight' then 1 end)`,
				fromPluginsCount: sql<number>`count(case when ${schema.mediaMarkers.source} = 'plugin' then 1 end)`,
			})
			.from(schema.mediaMarkers);

		return row;
	}
}

export const adminStatsRepository = new AdminStatsRepository();
