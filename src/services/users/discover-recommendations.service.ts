import type { MetadataType } from "@reelvault/sdk/common";
import { HOUR } from "@/config/server/server.constants";
import {
	findRecommendationCandidates,
	findRecommendationFallbackCandidates,
	findRecommendationFeatureRows,
	findRecommendationFeatureStats,
	findRecommendationQuality,
	findRecommendationSeedRows,
	type RecommendationCandidateRow,
	type RecommendationSeedRow,
} from "@/repositories/discover-recommendations.reader";
import { groupBy } from "@/utils/array.utils";
import { createLogger } from "@/utils/logger.utils";
import { clamp } from "@/utils/math.utils";
import { MemoryCache } from "@/utils/memory.cache";
import type { RecommendationFeatureKind, RecommendationFeatureRef, RecommendationFeatureStats } from "@/utils/recommendation-feature.utils";
import {
	RECOMMENDATION_CANDIDATE_FEATURE_DF_MAX_SHARE,
	RECOMMENDATION_CANDIDATE_LIMIT,
	RECOMMENDATION_COLD_START_TYPE_SHARE,
	RECOMMENDATION_MIN_ITEMS,
	RECOMMENDATION_MINORITY_TYPE_SHARE,
	RECOMMENDATION_SLATE_SEED_BUCKETS,
	RECOMMENDATION_TOP_FEATURES,
	RECOMMENDATION_TOP_FEATURES_PER_KIND,
} from "./recommendations/recommendation.constants";
import {
	type RecommendationCandidate,
	type RecommendationScore,
	recommendationSimilarityScale,
	scoreRecommendationCandidate,
	summarizeRecommendationVector,
} from "./recommendations/recommendation-score.utils";
import { buildRecommendationSeeds, type RecommendationSeedSet } from "./recommendations/recommendation-seed.builder";
import { buildRecommendationSlate } from "./recommendations/recommendation-slate.builder";
import { buildRecommendationTasteProfile, type RecommendationTasteProfile } from "./recommendations/recommendation-taste.builder";
import {
	buildRecommendationItemVector,
	type RecommendationItemVector,
	type WeightedRecommendationFeature,
} from "./recommendations/recommendation-vector.builder";

const logger = createLogger("DiscoverRecommendations");

const METADATA_TYPES: readonly MetadataType[] = ["movie", "tv_show"];

/** Genres are broad by nature, so they may cover more of the catalog than other candidate features. */
const GENRE_CANDIDATE_DF_MAX_SHARE = 0.7;

/** A single-type slate spends its whole budget on that type. */
const SINGLE_TYPE_SHARE: Record<MetadataType, number> = { movie: 1, tv_show: 1 };

/** Vectors depend only on the feature census, so one profile's work serves every other profile. */
const recommendationItemVectorCache = new MemoryCache<RecommendationItemVector>({
	ttlMs: HOUR,
	maxSize: 5000,
	name: "recommendation.item-vectors",
});

/** Crew jobs the census found informative; every other job is left out of vectors and candidates. */
function creditRolesOf(stats: RecommendationFeatureStats): string[] {
	return [...(stats.roleWeights?.keys() ?? [])];
}

/** The census the cached vectors were weighted with; a new census drops them. */
let vectorCacheStats: RecommendationFeatureStats | null = null;

/** Item vectors for `ids`, reading feature rows only for titles no profile has vectorized under this census. */
function loadVectors(ids: readonly string[], stats: RecommendationFeatureStats): Map<string, RecommendationItemVector> {
	if (stats !== vectorCacheStats) {
		recommendationItemVectorCache.clear();
		vectorCacheStats = stats;
	}

	const missing = ids.filter((id) => !recommendationItemVectorCache.has(id));
	const rowsByMetadata = groupBy(findRecommendationFeatureRows(missing, creditRolesOf(stats)), (row) => row.metadataId);
	const vectors = new Map<string, RecommendationItemVector>();

	for (const id of ids) {
		const cached = recommendationItemVectorCache.get(id);
		if (cached) {
			vectors.set(id, cached);
			continue;
		}

		const rows = rowsByMetadata.get(id) ?? [];
		if (rows.length === 0) continue;

		const vector = buildRecommendationItemVector(id, rows, stats);
		recommendationItemVectorCache.set(id, vector);
		vectors.set(id, vector);
	}

	return vectors;
}

function selectProfileFeatures(profile: RecommendationTasteProfile, stats: RecommendationFeatureStats): RecommendationFeatureRef[] {
	const byKind = new Map<RecommendationFeatureKind, WeightedRecommendationFeature[]>();
	const totalTitles = Math.max(1, stats.totalTitles);

	for (const feature of profile.positiveFeatures) {
		const share = (stats.documentFrequency.get(feature.key) ?? 0) / totalTitles;
		const maximumShare = feature.kind === "genre" ? GENRE_CANDIDATE_DF_MAX_SHARE : RECOMMENDATION_CANDIDATE_FEATURE_DF_MAX_SHARE;
		if (share > maximumShare || feature.idf < 1) continue;

		const group = byKind.get(feature.kind) ?? [];
		group.push(feature);
		byKind.set(feature.kind, group);
	}

	const selected: WeightedRecommendationFeature[] = [];
	for (const group of byKind.values()) {
		group.sort((left, right) => right.weight - left.weight);
		selected.push(...group.slice(0, RECOMMENDATION_TOP_FEATURES_PER_KIND));
	}

	selected.sort((left, right) => right.weight - left.weight);
	const limited = selected.slice(0, RECOMMENDATION_TOP_FEATURES);

	if (!limited.some((feature) => feature.kind === "genre")) {
		const genre = profile.positiveFeatures.find((feature) => feature.kind === "genre");
		if (genre) limited.push(genre);
	}

	return limited.map((feature) => ({ kind: feature.kind, id: feature.id }));
}

function coldStartEntry(
	candidate: RecommendationCandidate,
	vector: RecommendationItemVector,
	score: number,
	quality: number,
	freshness: number,
): RecommendationScore {
	const summary = summarizeRecommendationVector(vector);

	return {
		candidate,
		vector,
		score,
		qualifies: true,
		profileSimilarity: 0,
		seedSimilarity: 0,
		maxSeedSimilarity: 0,
		topSeedId: null,
		negativeSimilarity: 0,
		quality,
		freshness,
		era: 0.5,
		typeAffinity: 1,
		specificScore: 0,
		themeCount: 0,
		strongThemeCount: 0,
		bestThemeSpecificity: 0,
		castEvidence: 0,
		sharedGenres: 0,
		primaryGenreId: summary.primaryGenreId,
		primaryGenreLabel: summary.primaryGenreLabel,
		collectionIds: summary.collectionIds,
		creatorIds: summary.creatorIds,
	};
}

/** Fallback candidates per type: the best-rated list is mostly movies in a typical library. */
function fallbackCandidatesByType(
	excludeIds: readonly string[],
	limit: number,
	types: readonly MetadataType[],
): RecommendationCandidateRow[] {
	return types.flatMap((type) => findRecommendationFallbackCandidates({ excludeIds, limit: Math.max(100, limit * 5), type }));
}

/** Well-rated, recently added titles for a profile without usable viewing history. */
function coldStartEntries(limit: number, excludeIds: readonly string[], stats: RecommendationFeatureStats): RecommendationScore[] {
	const candidates = fallbackCandidatesByType(excludeIds, limit, METADATA_TYPES);
	if (candidates.length === 0) return [];

	const vectors = loadVectors(
		candidates.map((candidate) => candidate.id),
		stats,
	);
	const maximumPopularity = Math.max(1, ...candidates.map((candidate) => candidate.popularity));
	const now = Date.now();
	const entries: RecommendationScore[] = [];

	for (const candidate of candidates) {
		const vector = vectors.get(candidate.id);
		if (!vector) continue;

		const quality = candidate.ratingValue === null ? 0.5 : clamp(candidate.ratingValue / 10, 0, 1);
		let freshness = 0;
		if (candidate.latestMediaCreatedAt !== null) {
			const ageDays = Math.max(0, (now - candidate.latestMediaCreatedAt.getTime()) / 86_400_000);
			freshness = Math.exp(-ageDays / 90);
		}
		const popularity = candidate.popularity / maximumPopularity;
		entries.push(coldStartEntry(candidate, vector, quality * 0.5 + freshness * 0.3 + popularity * 0.2, quality, freshness));
	}

	return entries;
}

function scoreCandidates(
	candidates: readonly RecommendationCandidateRow[],
	profile: RecommendationTasteProfile,
	stats: RecommendationFeatureStats,
	{ withRatings, similarityScale }: { withRatings: boolean; similarityScale: number },
): RecommendationScore[] {
	const ids = candidates.map((candidate) => candidate.id);
	const vectors = loadVectors(ids, stats);
	// Fallback rows already carry their best rating; feature-matched rows do not.
	const quality = withRatings ? new Map<string, { value: number; votes: number }>() : findRecommendationQuality(ids);
	const now = Date.now();
	const scored: RecommendationScore[] = [];

	for (const candidate of candidates) {
		const vector = vectors.get(candidate.id);
		if (!vector) continue;

		const rating = quality.get(candidate.id);
		const enriched: RecommendationCandidate = {
			...candidate,
			ratingValue: rating?.value ?? candidate.ratingValue,
			ratingVotes: rating?.votes ?? candidate.ratingVotes,
		};
		scored.push(
			scoreRecommendationCandidate(enriched, vector, profile, { nowMs: now, meanRating: stats.globalMeanRating, similarityScale }),
		);
	}

	return scored;
}

/** A type gets its own row only when the profile watches enough of it or a title of that type earned its place. */
function isRowEligible(type: MetadataType, typeShare: Record<MetadataType, number>): boolean {
	return typeShare[type] >= RECOMMENDATION_MINORITY_TYPE_SHARE;
}

export interface RecommendationPipelineResult {
	seeds: RecommendationSeedRow[];
	seedSet: RecommendationSeedSet | null;
	profile: RecommendationTasteProfile | null;
	candidateCount: number;
	scored: RecommendationScore[];
	qualified: RecommendationScore[];
	/** Movies and shows ranked together, for clients that show one row. */
	slate: RecommendationScore[];
	/** One ranked list per type, for the separate movie and show rows. */
	slateByType: Record<MetadataType, RecommendationScore[]>;
}

function coldStartResult(
	seeds: RecommendationSeedRow[],
	seedSet: RecommendationSeedSet | null,
	entries: RecommendationScore[],
	limit: number,
): RecommendationPipelineResult {
	const typeShare = seedSet?.typeShare ?? RECOMMENDATION_COLD_START_TYPE_SHARE;
	const minimumItems = Math.min(limit, RECOMMENDATION_MIN_ITEMS);
	const slate = buildRecommendationSlate(entries, [], limit, typeShare, { minimumItems });
	const slateByType: Record<MetadataType, RecommendationScore[]> = { movie: [], tv_show: [] };
	for (const type of METADATA_TYPES) {
		if (!isRowEligible(type, typeShare)) continue;

		const typed = entries.filter((entry) => entry.candidate.type === type);
		slateByType[type] = buildRecommendationSlate(typed, [], limit, SINGLE_TYPE_SHARE, { minimumItems });
	}

	return { seeds, seedSet, profile: null, candidateCount: 0, scored: entries, qualified: entries, slate, slateByType };
}

/**
 * Backfill for short slates: non-qualifying scored titles, plus best-rated
 * titles of each type whose row is eligible but has fewer than the minimum.
 * Never fills to the limit, so unrelated popular titles cannot manufacture relevance.
 */
function backfillScores(
	scored: readonly RecommendationScore[],
	qualified: readonly RecommendationScore[],
	profile: RecommendationTasteProfile,
	context: { seedIds: readonly string[]; stats: RecommendationFeatureStats; limit: number; similarityScale: number },
): RecommendationScore[] {
	const shortTypes = METADATA_TYPES.filter(
		(type) =>
			isRowEligible(type, profile.typeShare) &&
			qualified.filter((entry) => entry.candidate.type === type).length < RECOMMENDATION_MIN_ITEMS,
	);
	if (shortTypes.length === 0) return [];

	const scoredIds = new Set(scored.map((entry) => entry.candidate.id));
	const extraCandidates = fallbackCandidatesByType(context.seedIds, context.limit, shortTypes).filter(
		(candidate) => !scoredIds.has(candidate.id),
	);
	const extra = scoreCandidates(extraCandidates, profile, context.stats, { withRatings: true, similarityScale: context.similarityScale });

	return [...scored.filter((entry) => !entry.qualifies), ...extra].filter((entry) => shortTypes.includes(entry.candidate.type));
}

function buildSlates(
	qualified: readonly RecommendationScore[],
	fallback: readonly RecommendationScore[],
	limit: number,
	profile: RecommendationTasteProfile,
): Pick<RecommendationPipelineResult, "slate" | "slateByType"> {
	const topSeedIds = profile.seedVectors.slice(0, RECOMMENDATION_SLATE_SEED_BUCKETS).map((entry) => entry.seed.metadataId);
	const slate = buildRecommendationSlate(qualified, fallback, limit, profile.typeShare, {
		minimumItems: RECOMMENDATION_MIN_ITEMS,
		topSeedIds,
	});
	const slateByType: Record<MetadataType, RecommendationScore[]> = { movie: [], tv_show: [] };

	for (const type of METADATA_TYPES) {
		const typed = qualified.filter((entry) => entry.candidate.type === type);
		const eligible = isRowEligible(type, profile.typeShare);
		slateByType[type] = buildRecommendationSlate(
			typed,
			eligible ? fallback.filter((entry) => entry.candidate.type === type) : [],
			limit,
			SINGLE_TYPE_SHARE,
			{ minimumItems: eligible ? RECOMMENDATION_MIN_ITEMS : 0, topSeedIds },
		);
	}

	return { slate, slateByType };
}

function findProfileCandidates(
	profile: RecommendationTasteProfile,
	stats: RecommendationFeatureStats,
	seedIds: readonly string[],
	smallCatalog: boolean,
): RecommendationCandidateRow[] {
	// Small catalogs are cheap to score exhaustively. The fallback query is
	// only the candidate source; the scorer decides the final order.
	if (smallCatalog) return findRecommendationFallbackCandidates({ excludeIds: seedIds, limit: stats.totalTitles });

	const features = selectProfileFeatures(profile, stats);
	if (features.length === 0) return [];

	return findRecommendationCandidates({
		features,
		excludeIds: seedIds,
		limit: RECOMMENDATION_CANDIDATE_LIMIT,
		creditRoles: creditRolesOf(stats),
	});
}

/** Builds the profile's recommendation slates and keeps the score breakdown for tuning and tests. */
export function buildRecommendations(profileId: string, requestedLimit: number): RecommendationPipelineResult {
	const limit = clamp(requestedLimit, 1, 50);
	const seeds = findRecommendationSeedRows(profileId);
	const seedIds = seeds.map((seed) => seed.metadataId);
	const stats = findRecommendationFeatureStats();

	if (seeds.length === 0) return coldStartResult(seeds, null, coldStartEntries(limit, [], stats), limit);

	const seedSet = buildRecommendationSeeds(seeds, Date.now());
	const profile = buildRecommendationTasteProfile(seedSet, loadVectors(seedIds, stats), stats.totalTitles);
	if (!profile) return coldStartResult(seeds, seedSet, coldStartEntries(limit, seedIds, stats), limit);

	const smallCatalog = stats.totalTitles <= RECOMMENDATION_CANDIDATE_LIMIT;
	const candidates = findProfileCandidates(profile, stats, seedIds, smallCatalog);
	if (candidates.length === 0) return coldStartResult(seeds, seedSet, coldStartEntries(limit, seedIds, stats), limit);

	// Backfill titles are judged on the same scale as the profile's own candidates.
	const similarityScale = recommendationSimilarityScale(
		loadVectors(
			candidates.map((candidate) => candidate.id),
			stats,
		).values(),
		profile,
	);
	const scored = scoreCandidates(candidates, profile, stats, { withRatings: smallCatalog, similarityScale });
	const qualified = scored.filter((entry) => entry.qualifies).toSorted((left, right) => right.score - left.score);
	const fallback = backfillScores(scored, qualified, profile, { seedIds, stats, limit, similarityScale });
	const { slate, slateByType } = buildSlates(qualified, fallback, limit, profile);

	logger.debug("Recommendation slate built", {
		profileId,
		seeds: profile.seedCount,
		candidates: candidates.length,
		qualified: qualified.length,
		served: { all: slate.length, movie: slateByType.movie.length, tv_show: slateByType.tv_show.length },
		top: slate.slice(0, 5).map((entry) => ({
			id: entry.candidate.id,
			score: Number(entry.score.toFixed(3)),
			genre: entry.primaryGenreLabel,
		})),
	});

	return { seeds, seedSet, profile, candidateCount: candidates.length, scored, qualified, slate, slateByType };
}
