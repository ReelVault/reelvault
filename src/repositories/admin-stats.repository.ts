import { and, eq, isNotNull, lt } from "drizzle-orm";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { REVIEW_MATCH_SCORE } from "@/utils/media-match/score.constants";

const mediaFiles = defineTableAccess("mediaFiles", { primaryKeyColumn: "id" });
const metadata = defineTableAccess("metadata", { primaryKeyColumn: "id" });
const mediaMarkers = defineTableAccess("mediaMarkers", { primaryKeyColumn: "id" });

/** Aggregate counts backing the admin dashboard stats card. */
export const adminStatsRepository = {
	async getMediaStats() {
		return await mediaFiles.countAggregates({
			total: "totalFiles",
			sum: { key: "totalSize", column: mediaFiles.table.size },
			counts: {
				moviesCount: isNotNull(mediaFiles.table.movieId),
				episodesCount: isNotNull(mediaFiles.table.episodeId),
				withQualityCount: isNotNull(mediaFiles.table.qualityTag),
			},
		});
	},

	async getMetadataStats() {
		return await metadata.countAggregates({
			total: "totalCount",
			counts: {
				moviesCount: eq(metadata.table.type, "movie"),
				tvShowsCount: eq(metadata.table.type, "tv_show"),
				lowConfidenceCount: and(isNotNull(metadata.table.matchScore), lt(metadata.table.matchScore, REVIEW_MATCH_SCORE)),
				missingTranslationCount: eq(metadata.table.hasMissingTranslation, true),
			},
		});
	},

	async getMarkerStats() {
		return await mediaMarkers.countAggregates({
			total: "totalCount",
			counts: {
				introsCount: eq(mediaMarkers.table.type, "intro"),
				creditsCount: eq(mediaMarkers.table.type, "credits"),
				highlightsCount: eq(mediaMarkers.table.type, "highlight"),
				fromPluginsCount: eq(mediaMarkers.table.source, "plugin"),
			},
		});
	},
};
