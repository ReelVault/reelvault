import type { MetadataWithRelation } from "@reelvault/sdk";
import type { DiscoverResponse } from "@reelvault/sdk/common";
import { discoverRepository } from "@/database/repositories/discover.repository";
import { metadataRepository } from "@/database/repositories/metadata.repository";
import { MINUTE } from "@/server.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { groupBy, isNotNullish, toMap, unique } from "@/utils/array.utils";
import { BaseService } from "@/utils/base-service";
import { clamp } from "@/utils/math.utils";
import { MemoryCache } from "@/utils/memory-cache";
import {
	applyDiversityFilter,
	buildRelationScores,
	buildTrending,
	coldStartFallback,
	completionBonus,
	type ProgressSignal,
	RATING_WEIGHTS,
	recencyMultiplier,
	SIGNAL_WEIGHTS,
	scoreCandidate,
	seedTimestamp,
	TRENDING_CANDIDATE_LIMIT,
	TRENDING_DAYS,
	WATCH_COUNT_MULTIPLIER,
	WATCHLIST_BASE_BONUS,
} from "./discover-recommendations";

function buildSeedWeights(
	watched: Array<{ metadataId: string | null; watchCount: number }>,
	watchlist: Array<{ metadataId: string | null; createdAt: Date }>,
	ratings: Array<{ metadataId: string | null; rating: number }>,
	progressMap: Map<string, ProgressSignal>,
): Map<string, number> {
	const seedWeights = new Map<string, number>();

	for (const item of watched) {
		if (!item.metadataId) continue;

		const ts = seedTimestamp(progressMap, item.metadataId);
		const decay = recencyMultiplier(ts);
		const base = (WATCH_COUNT_MULTIPLIER * item.watchCount + completionBonus(progressMap, item.metadataId)) * decay;
		const prev = seedWeights.get(item.metadataId) ?? 0;
		seedWeights.set(item.metadataId, prev + base);
	}

	for (const item of watchlist) {
		if (!item.metadataId) continue;

		const decay = recencyMultiplier(item.createdAt.getTime());
		const prev = seedWeights.get(item.metadataId) ?? 0;
		seedWeights.set(item.metadataId, prev + WATCHLIST_BASE_BONUS * decay);
	}

	for (const item of ratings) {
		if (!item.metadataId) continue;

		let ratingDelta: number;
		if (item.rating === 2) ratingDelta = RATING_WEIGHTS.like;
		else if (item.rating === 1) ratingDelta = RATING_WEIGHTS.neutral;
		else ratingDelta = RATING_WEIGHTS.dislike;

		const prev = seedWeights.get(item.metadataId) ?? 0;
		seedWeights.set(item.metadataId, prev + ratingDelta);
	}

	return seedWeights;
}

class DiscoverService extends BaseService {
	private readonly cache = new MemoryCache<DiscoverResponse>({
		ttlMs: MINUTE,
		maxSize: systemResourcesService.getRamScaledCacheEntries(12, 25, 100),
		name: "discover",
	});

	constructor() {
		super("DiscoverService");
	}

	async getDiscoverView(query: { limit?: number }, profileId?: string): Promise<DiscoverResponse> {
		this.assertExists(profileId, "Profile", "auth");
		const limit = clamp(query.limit ?? 10, 1, 50);

		const full = await this.cache.getOrSet(profileId, () => this.buildDiscoverView(profileId));

		return {
			recentlyAddedMovies: full.recentlyAddedMovies.slice(0, limit),
			recentlyAddedShows: full.recentlyAddedShows.slice(0, limit),
			recommendations: full.recommendations.slice(0, limit),
			trending: full.trending.slice(0, limit),
		};
	}

	private async buildDiscoverView(profileId: string): Promise<DiscoverResponse> {
		// Cache the maximum-size view once per profile; callers slice to their limit.
		const limit = 50;
		const [recentlyAddedMovies, recentlyAddedShows, recommendationIds, trendingRaw] = await Promise.all([
			metadataRepository.findRecentlyAddedByType("movie", limit),
			metadataRepository.findRecentlyAddedByType("tv_show", limit),
			this.getRecommendations(profileId, limit).catch((err) => {
				this.logger.warn("Failed to generate recommendations for discover view, falling back to empty list", { profileId, err });

				return [];
			}),
			discoverRepository.findRecentlyWatchedByOthers(TRENDING_DAYS, TRENDING_CANDIDATE_LIMIT).catch(() => []),
		]);

		const recentlyAddedAll = [...recentlyAddedMovies, ...recentlyAddedShows];

		// Hydrate recommendation items that are not already in recentlyAdded.
		const recentlyAddedMap = toMap(recentlyAddedAll, (m) => m.id);
		const missingRecIds = recommendationIds.filter((id) => !recentlyAddedMap.has(id));
		const missingEnriched = missingRecIds.length > 0 ? await metadataRepository.findManyByIdsWithRelations(missingRecIds) : [];
		const enrichedMap = toMap([...recentlyAddedAll, ...missingEnriched], (m) => m.id);
		const hydratedRecs: MetadataWithRelation[] = recommendationIds.map((id) => enrichedMap.get(id)).filter((v) => isNotNullish(v));

		const trending = await buildTrending(trendingRaw, recentlyAddedAll, limit, enrichedMap);

		const result: DiscoverResponse = {
			recentlyAddedMovies,
			recentlyAddedShows,
			recommendations: hydratedRecs,
			trending,
		};

		return result;
	}

	clearCache(profileId?: string): void {
		if (profileId) {
			// Cache keys are the profileId itself (not a `profileId:...` prefix).
			this.cache.delete(profileId);
		} else {
			this.cache.clear();
		}
	}

	private async getRecommendations(profileId: string, limit: number): Promise<string[]> {
		return await this.safeExecute("getRecommendations", async () => {
			const [{ watched, ratings, watchlist, catalog }, progressSignals] = await Promise.all([
				discoverRepository.findRecommendationCandidates(profileId),
				discoverRepository.findPlaybackCompletionSignals(profileId),
			]);

			const watchedIds = toIdSet(watched, (item) => item.metadataId);
			const watchlistIds = toIdSet(watchlist, (item) => item.metadataId);
			const progressMap = toMap(progressSignals, (p) => p.metadataId);

			const seedWeights = buildSeedWeights(watched, watchlist, ratings, progressMap);

			const unconsumedCandidates = catalog.filter((item) => item.id && !watchedIds.has(item.id) && !watchlistIds.has(item.id));

			if (unconsumedCandidates.length === 0) return [];

			if (seedWeights.size === 0) {
				const fallback = coldStartFallback(unconsumedCandidates, limit);

				return fallback.map((item) => item.id);
			}

			const candidateIds = toIdSet(unconsumedCandidates, (item) => item.id);
			const allRelevantIds = unique([...seedWeights.keys(), ...candidateIds]);

			const [genreRows, keywordRows, castRows] = await Promise.all([
				discoverRepository.findMetadataGenres(allRelevantIds),
				discoverRepository.findMetadataKeywords(allRelevantIds),
				discoverRepository.findMetadataCast(allRelevantIds),
			]);

			const genresByMetadata = groupBy(
				genreRows,
				(r) => r.metadataId,
				(r) => r.relId,
			);
			const keywordsByMetadata = groupBy(
				keywordRows,
				(r) => r.metadataId,
				(r) => r.relId,
			);
			const castByMetadata = groupBy(
				castRows,
				(r) => r.metadataId,
				(r) => r.relId,
			);

			const genreScores = buildRelationScores(genresByMetadata, seedWeights, SIGNAL_WEIGHTS.genre);
			const keywordScores = buildRelationScores(keywordsByMetadata, seedWeights, SIGNAL_WEIGHTS.keyword);
			const castScores = buildRelationScores(castByMetadata, seedWeights, SIGNAL_WEIGHTS.cast);

			const scored = unconsumedCandidates.map((item) => ({
				item,
				score: scoreCandidate(
					genresByMetadata.get(item.id) ?? [],
					keywordsByMetadata.get(item.id) ?? [],
					castByMetadata.get(item.id) ?? [],
					item.popularity,
					genreScores,
					keywordScores,
					castScores,
				),
			}));
			scored.sort((a, b) => b.score - a.score || b.item.popularity - a.item.popularity);

			const primaryGenreOf = toMap(
				[...candidateIds],
				(id) => id,
				(id) => genresByMetadata.get(id)?.[0],
			);
			const scoredItems = scored.map((s) => s.item);
			const diversified = applyDiversityFilter(scoredItems, primaryGenreOf, limit);

			return diversified.map((item) => item.id);
		});
	}
}

function toIdSet<T>(items: readonly T[], keyFn: (item: T) => string | null | undefined): Set<string> {
	return new Set(unique(items, keyFn).filter((id): id is string => Boolean(id)));
}

export const discoverService = new DiscoverService();
