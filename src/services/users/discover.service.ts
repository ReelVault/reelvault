import type { MetadataWithRelation } from "@reelvault/sdk";
import type { DiscoverResponse } from "@reelvault/sdk/common";
import { MINUTE } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import { discoverRepository } from "@/repositories/discover.repository";
import { findDislikedMetadataIds, findMetadataTitles } from "@/repositories/discover-recommendations.reader";
import { metadataRepository } from "@/repositories/metadata.repository";
import { toMap } from "@/utils/array.utils";
import { assertProfileId } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { clamp } from "@/utils/math.utils";
import { MemoryCache } from "@/utils/memory.cache";
import { runSafely } from "@/utils/safe-execute.utils";
import { isNotNullish } from "@/utils/type.utils";
import { buildRecommendations, type RecommendationPipelineResult } from "./discover-recommendations.service";
import { buildTrending, TRENDING_CANDIDATE_LIMIT, TRENDING_DAYS } from "./recommendation-trending.service";
import { buildRecommendationReasons, reasonSeedIds } from "./recommendations/recommendation-reasons.builder";

/**
 * Discover builds at most this many recommendations. The route may still ask
 * for 50 items, but recently added and trending keep the full 50 while a
 * longer recommendation slate only adds MMR and hydration work.
 */
const DISCOVER_RECOMMENDATION_LIMIT = 20;

function emptyRecommendationResult(): RecommendationPipelineResult {
	return {
		seeds: [],
		seedSet: null,
		profile: null,
		candidateCount: 0,
		scored: [],
		qualified: [],
		slate: [],
		slateByType: { movie: [], tv_show: [] },
	};
}

class DiscoverService {
	readonly serviceName = "DiscoverService";
	readonly logger = createLogger("DiscoverService");

	private readonly cache = new MemoryCache<DiscoverResponse>({
		ttlMs: MINUTE,
		maxSize: systemResourcesService.getRamScaled(12, 25, 100),
		name: "discover",
	});

	async getDiscoverView(query: { limit?: number }, profileId?: string): Promise<DiscoverResponse> {
		assertProfileId(profileId);
		const limit = clamp(query.limit ?? 10, 1, 50);

		const full = await this.cache.getOrSet(profileId, () => this.buildDiscoverView(profileId));
		const recommendations = full.recommendations.slice(0, limit);
		const recommendedMovies = (full.recommendedMovies ?? []).slice(0, limit);
		const recommendedShows = (full.recommendedShows ?? []).slice(0, limit);
		// The three lists are sliced separately, so keep the reason of every title any of them still serves.
		const servedIds = new Set([...recommendations, ...recommendedMovies, ...recommendedShows].map((metadata) => metadata.id));

		return {
			recentlyAddedMovies: full.recentlyAddedMovies.slice(0, limit),
			recentlyAddedShows: full.recentlyAddedShows.slice(0, limit),
			recommendations,
			recommendedMovies,
			recommendedShows,
			recommendationReasons: (full.recommendationReasons ?? []).filter((reason) => servedIds.has(reason.metadataId)),
			trending: full.trending.slice(0, limit),
		};
	}

	private async buildDiscoverView(profileId: string): Promise<DiscoverResponse> {
		// Cache the maximum-size view once per profile; callers slice to their limit.
		const limit = 50;
		const [recentlyAdded, recommendationResult, dislikedIds, trendingRaw] = await Promise.all([
			metadataRepository.findRecentlyAddedByTypes(["movie", "tv_show"], limit),
			this.getRecommendations(profileId, DISCOVER_RECOMMENDATION_LIMIT).catch((error: unknown) => {
				this.logger.warn("Failed to generate recommendations for discover view, falling back to empty list", { profileId, err: error });

				return emptyRecommendationResult();
			}),
			findDislikedMetadataIds(profileId).catch((error: unknown) => {
				this.logger.warn("Failed to load disliked titles for discover view, falling back to none", { profileId, err: error });

				return new Set<string>();
			}),
			discoverRepository.findRecentlyWatchedByOthers(TRENDING_DAYS, TRENDING_CANDIDATE_LIMIT).catch((error: unknown) => {
				this.logger.warn("Failed to load trending titles for discover view, falling back to none", { profileId, err: error });

				return [];
			}),
		]);

		const { slate, slateByType, profile } = recommendationResult;
		const servedEntries = [...slate, ...slateByType.movie, ...slateByType.tv_show];
		const recommendationIds = [...new Set(servedEntries.map((entry) => entry.candidate.id))];
		const trending = trendingRaw.filter((row) => !(row.metadataId && dislikedIds.has(row.metadataId)));
		const recentlyAddedMovies = recentlyAdded.get("movie") ?? [];
		const recentlyAddedShows = recentlyAdded.get("tv_show") ?? [];
		const recentlyAddedAll = [...recentlyAddedMovies, ...recentlyAddedShows];

		// Hydrate the recommendation and trending items that are not already in
		// recentlyAdded — in one read, so the two lists do not fetch the same
		// titles twice.
		const recentlyAddedMap = toMap(recentlyAddedAll, (metadata) => metadata.id);
		const missingRecommendationIds = recommendationIds.filter((id) => !recentlyAddedMap.has(id));
		const missingTrendingIds = trending.map((row) => row.metadataId).filter((id): id is string => Boolean(id) && !recentlyAddedMap.has(id));
		const missingIds = [...new Set([...missingRecommendationIds, ...missingTrendingIds])];
		let missingEnriched: MetadataWithRelation[] = [];
		if (missingIds.length > 0) {
			missingEnriched = await metadataRepository.findManyByIdsWithRelations(missingIds);
		}
		const enrichedMap = toMap([...recentlyAddedAll, ...missingEnriched], (metadata) => metadata.id);
		const hydrate = (entries: ReadonlyArray<{ candidate: { id: string } }>): MetadataWithRelation[] =>
			entries.map((entry) => enrichedMap.get(entry.candidate.id)).filter((metadata) => isNotNullish(metadata));
		const reasonsById = new Map(
			buildRecommendationReasons(servedEntries, profile, this.loadSeedTitles(servedEntries)).map((reason) => [reason.metadataId, reason]),
		);

		return {
			recentlyAddedMovies,
			recentlyAddedShows,
			recommendations: hydrate(slate),
			recommendedMovies: hydrate(slateByType.movie),
			recommendedShows: hydrate(slateByType.tv_show),
			recommendationReasons: [...reasonsById.values()].filter((reason) => enrichedMap.has(reason.metadataId)),
			trending: await buildTrending(trending, recentlyAddedAll, limit, enrichedMap),
		};
	}

	/** Titles for "Because you watched" reasons; a failed read only drops those reasons to the next kind. */
	private loadSeedTitles(entries: Parameters<typeof reasonSeedIds>[0]): Map<string, string> {
		try {
			return findMetadataTitles(reasonSeedIds(entries));
		} catch (error: unknown) {
			this.logger.warn("Failed to load seed titles for recommendation reasons", { err: error });

			return new Map();
		}
	}

	clearCache(profileId?: string): void {
		if (profileId) {
			// Cache keys are the profileId itself (not a `profileId:...` prefix).
			this.cache.delete(profileId);
		} else {
			this.cache.clear();
		}
	}

	private async getRecommendations(profileId: string, limit: number): Promise<RecommendationPipelineResult> {
		return await runSafely(this, "getRecommendations", () => buildRecommendations(profileId, limit));
	}
}

export const discoverService = new DiscoverService();
