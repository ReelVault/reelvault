import type { MetadataType } from "@reelvault/sdk/common";
import { DAY } from "@/config/server/server.constants";
import { cosineSimilarity, type RecommendationFeatureKind, releaseYear } from "@/utils/recommendation-feature.utils";
import {
	RECOMMENDATION_CAST_EVIDENCE_SCORE,
	RECOMMENDATION_CAST_EVIDENCE_WEIGHT,
	RECOMMENDATION_ERA_SIGMA_YEARS,
	RECOMMENDATION_FRESHNESS_DAYS,
	RECOMMENDATION_MIN_SIMILARITY_SCALE,
	RECOMMENDATION_MIN_THEME_EVIDENCE,
	RECOMMENDATION_MINORITY_TYPE_SHARE,
	RECOMMENDATION_PRIOR_INFLUENCE,
	RECOMMENDATION_QUALITY_MIN_VOTES,
	RECOMMENDATION_SCORE_WEIGHTS,
	RECOMMENDATION_SEED_SIMILARITY_COUNT,
	RECOMMENDATION_STRONG_SEED_SIMILARITY,
	RECOMMENDATION_STRONG_SPECIFICITY,
	RECOMMENDATION_STRONG_THEME_SEED_SIMILARITY,
	RECOMMENDATION_THEME_SEED_SIMILARITY,
	RECOMMENDATION_THEME_SPECIFICITY,
	RECOMMENDATION_TYPE_AFFINITY,
} from "./recommendation.constants";
import { closestSeed, type RecommendationTasteProfile, seedSimilarity, themesOnlyVector } from "./recommendation-taste.builder";
import type { RecommendationItemVector } from "./recommendation-vector.builder";

export interface RecommendationCandidate {
	id: string;
	type: MetadataType;
	popularity: number;
	releaseDate: string;
	createdAt: Date | null;
	latestMediaCreatedAt: Date | null;
	ratingValue: number | null;
	ratingVotes: number | null;
}

export interface RecommendationScore {
	candidate: RecommendationCandidate;
	vector: RecommendationItemVector;
	score: number;
	qualifies: boolean;
	profileSimilarity: number;
	seedSimilarity: number;
	maxSeedSimilarity: number;
	topSeedId: string | null;
	negativeSimilarity: number;
	quality: number;
	freshness: number;
	era: number;
	typeAffinity: number;
	specificScore: number;
	themeCount: number;
	strongThemeCount: number;
	bestThemeSpecificity: number;
	castEvidence: number;
	sharedGenres: number;
	primaryGenreId: string | null;
	primaryGenreLabel: string | null;
	collectionIds: string[];
	creatorIds: string[];
}

export interface RecommendationVectorSummary {
	primaryGenreId: string | null;
	primaryGenreLabel: string | null;
	collectionIds: string[];
	creatorIds: string[];
}

/** The slate caps need the same genre/creator/collection labels the scorer used. */
export function summarizeRecommendationVector(vector: RecommendationItemVector): RecommendationVectorSummary {
	const genres: Array<{ id: string; label: string | null; weight: number }> = [];
	const collectionIds: string[] = [];
	const creatorIds: string[] = [];

	for (const feature of vector.features.values()) {
		if (feature.kind === "genre") genres.push({ id: feature.id, label: feature.label, weight: feature.weight });
		if (feature.kind === "collection") collectionIds.push(feature.id);
		if (isCappedPersonKind(feature.kind)) creatorIds.push(feature.id);
	}

	genres.sort((left, right) => right.weight - left.weight);

	return {
		primaryGenreId: genres[0]?.id ?? null,
		primaryGenreLabel: genres[0]?.label ?? null,
		collectionIds,
		creatorIds,
	};
}

function bayesianQuality(candidate: RecommendationCandidate, meanRating: number): number {
	const value = candidate.ratingValue ?? meanRating;
	const votes = Math.max(0, candidate.ratingVotes ?? 0);
	const minimum = RECOMMENDATION_QUALITY_MIN_VOTES;
	const weighted = (votes / (votes + minimum)) * value + (minimum / (votes + minimum)) * meanRating;

	return Math.min(1, Math.max(0, weighted / 10));
}

function freshness(candidate: RecommendationCandidate, nowMs: number): number {
	const timestamp = candidate.latestMediaCreatedAt?.getTime();
	if (timestamp === undefined) return 0;

	const days = Math.max(0, (nowMs - timestamp) / DAY);

	return Math.exp(-days / RECOMMENDATION_FRESHNESS_DAYS);
}

function eraSimilarity(candidate: RecommendationCandidate, preferredYear: number | null): number {
	const year = releaseYear(candidate.releaseDate);
	if (year === null || preferredYear === null) return 0.5;

	return Math.max(0, 1 - Math.abs(year - preferredYear) / RECOMMENDATION_ERA_SIGMA_YEARS);
}

function typeAffinity(type: MetadataType, profile: RecommendationTasteProfile): number {
	return RECOMMENDATION_TYPE_AFFINITY.base + RECOMMENDATION_TYPE_AFFINITY.range * profile.typeShare[type];
}

/** Crew credits share the slate cap: one director, writer or composer cannot crowd the list. */
function isCappedPersonKind(kind: RecommendationFeatureKind): boolean {
	return kind === "credit";
}

interface FeatureMatch {
	specificScore: number;
	themeCount: number;
	/** Sum of the shared themes' specificities. */
	themeEvidence: number;
	strongThemeCount: number;
	bestThemeSpecificity: number;
	castEvidence: number;
	sharedGenres: number;
	primaryGenreId: string | null;
	primaryGenreLabel: string | null;
	collectionIds: string[];
	creatorIds: string[];
}

/**
 * A candidate qualifies only when it shares evidence specific enough to be
 * meaningful. A single medium theme is not enough; one strong theme is, and
 * weaker themes combine once their specificities reach the evidence floor. Genres alone never qualify unless the profile has
 * no specific features at all (a library with tags/genres only).
 */
function matchFeatures(profile: RecommendationTasteProfile, candidate: RecommendationItemVector): FeatureMatch {
	const genres: Array<{ id: string; label: string | null; weight: number }> = [];
	const collectionIds: string[] = [];
	const creatorIds: string[] = [];
	let specificScore = 0;
	let themeCount = 0;
	let themeEvidence = 0;
	let strongThemeCount = 0;
	let bestThemeSpecificity = 0;
	let castEvidence = 0;

	for (const [key, feature] of candidate.features) {
		if (!profile.evidenceVector.features.has(key)) continue;

		if (feature.kind === "genre") {
			genres.push({ id: feature.id, label: feature.label, weight: feature.weight });
			continue;
		}

		// A credit counts as much as its job tells about a title: a shared director
		// nearly as much as a specific theme, a shared composer a little less.
		const specificity = feature.specificity * feature.roleWeight;
		if (specificity < RECOMMENDATION_THEME_SPECIFICITY) continue;

		if (isCappedPersonKind(feature.kind)) creatorIds.push(feature.id);

		// A billed actor is supporting evidence, not a theme: it never qualifies on its own.
		if (feature.kind === "cast") {
			const evidence = specificity * RECOMMENDATION_CAST_EVIDENCE_WEIGHT;
			specificScore += evidence;
			castEvidence += evidence;
			continue;
		}

		specificScore += specificity;
		themeCount += 1;
		themeEvidence += specificity;
		bestThemeSpecificity = Math.max(bestThemeSpecificity, specificity);
		if (specificity >= RECOMMENDATION_STRONG_SPECIFICITY) strongThemeCount += 1;

		if (feature.kind === "collection") collectionIds.push(feature.id);
	}

	genres.sort((left, right) => right.weight - left.weight);

	return {
		specificScore,
		themeCount,
		themeEvidence,
		strongThemeCount,
		bestThemeSpecificity,
		castEvidence,
		sharedGenres: genres.length,
		primaryGenreId: genres[0]?.id ?? null,
		primaryGenreLabel: genres[0]?.label ?? null,
		collectionIds,
		creatorIds,
	};
}

function hasGenreFeature(profile: RecommendationTasteProfile): boolean {
	for (const feature of profile.evidenceVector.features.values()) {
		if (feature.kind === "genre") return true;
	}

	return false;
}

/** The profile's best theme resemblance among `vectors`, floored at `RECOMMENDATION_MIN_SIMILARITY_SCALE`. */
export function recommendationSimilarityScale(vectors: Iterable<RecommendationItemVector>, profile: RecommendationTasteProfile): number {
	let best = 0;
	for (const vector of vectors) {
		best = Math.max(best, closestSeed(themesOnlyVector(vector), profile.seedThemeVectors)?.similarity ?? 0);
	}

	return Math.max(RECOMMENDATION_MIN_SIMILARITY_SCALE, best);
}

export interface RecommendationScoreContext {
	nowMs: number;
	/** The catalog's mean rating on a 10-point scale, the prior for titles with few votes. */
	meanRating: number;
	/** The profile's similarity scale (`recommendationSimilarityScale`); the resemblance thresholds are shares of it. */
	similarityScale: number;
}

export function scoreRecommendationCandidate(
	candidate: RecommendationCandidate,
	vector: RecommendationItemVector,
	profile: RecommendationTasteProfile,
	context: RecommendationScoreContext,
): RecommendationScore {
	const { nowMs, meanRating, similarityScale } = context;
	const match = matchFeatures(profile, vector);
	const closest = closestSeed(themesOnlyVector(vector), profile.seedThemeVectors);
	const maxSimilarity = closest?.similarity ?? 0;
	const strongSeed = RECOMMENDATION_STRONG_SEED_SIMILARITY * similarityScale;
	const themeSeed = RECOMMENDATION_THEME_SEED_SIMILARITY * similarityScale;
	const strongThemeSeed = RECOMMENDATION_STRONG_THEME_SEED_SIMILARITY * similarityScale;
	const isMinorityType = profile.typeShare[candidate.type] < RECOMMENDATION_MINORITY_TYPE_SHARE;
	const hasMinorityEvidence = !isMinorityType || match.themeEvidence >= RECOMMENDATION_MIN_THEME_EVIDENCE || maxSimilarity >= strongSeed;
	// Shared mood tags can make a title from another kind of storytelling (an
	// animated family film for a teen drama profile) look close to a watched one.
	// Genres exist in every provider's taxonomy, so a title must share at least
	// one with the profile; a catalog without genres skips the check.
	const genreCompatible = match.sharedGenres > 0 || !hasGenreFeature(profile);
	const qualifies =
		genreCompatible &&
		hasMinorityEvidence &&
		((match.strongThemeCount > 0 && maxSimilarity >= strongThemeSeed) ||
			match.themeEvidence >= RECOMMENDATION_MIN_THEME_EVIDENCE ||
			(match.themeCount >= 1 && maxSimilarity >= themeSeed) ||
			maxSimilarity >= strongSeed ||
			(match.castEvidence >= RECOMMENDATION_CAST_EVIDENCE_SCORE && match.themeCount >= 1) ||
			(profile.specificFeatureCount < 2 && match.sharedGenres >= 2));
	const profileSimilarity = cosineSimilarity(profile.positiveVector, vector);
	const itemToItemSimilarity = seedSimilarity(vector, profile.seedVectors, RECOMMENDATION_SEED_SIMILARITY_COUNT);
	const negativeSimilarity = profile.negativeVector ? cosineSimilarity(profile.negativeVector, vector) : 0;
	const quality = bayesianQuality(candidate, meanRating);
	const fresh = freshness(candidate, nowMs);
	const era = eraSimilarity(candidate, profile.preferredYear);
	const affinity = typeAffinity(candidate.type, profile);

	const content =
		profileSimilarity * RECOMMENDATION_SCORE_WEIGHTS.profile +
		itemToItemSimilarity * RECOMMENDATION_SCORE_WEIGHTS.seed -
		negativeSimilarity * RECOMMENDATION_SCORE_WEIGHTS.negative +
		Math.min(1, match.specificScore) * RECOMMENDATION_SCORE_WEIGHTS.specificity;
	const { quality: qualityWeight, freshness: freshnessWeight, era: eraWeight } = RECOMMENDATION_SCORE_WEIGHTS;
	// Content similarities are small (0.03–0.15 on a real catalog), so an added
	// prior would let a fresh, well-rated title outrank a closer match. As a
	// bounded multiplier it only orders titles that match about equally well.
	const prior = (quality * qualityWeight + fresh * freshnessWeight + era * eraWeight) / (qualityWeight + freshnessWeight + eraWeight);
	const priorFactor = 1 - RECOMMENDATION_PRIOR_INFLUENCE + RECOMMENDATION_PRIOR_INFLUENCE * prior;

	return {
		candidate,
		vector,
		score: content * priorFactor * affinity,
		qualifies,
		profileSimilarity,
		seedSimilarity: itemToItemSimilarity,
		maxSeedSimilarity: maxSimilarity,
		topSeedId: closest?.id ?? null,
		negativeSimilarity,
		quality,
		freshness: fresh,
		era,
		typeAffinity: affinity,
		specificScore: match.specificScore,
		themeCount: match.themeCount,
		strongThemeCount: match.strongThemeCount,
		bestThemeSpecificity: match.bestThemeSpecificity,
		castEvidence: match.castEvidence,
		sharedGenres: match.sharedGenres,
		primaryGenreId: match.primaryGenreId,
		primaryGenreLabel: match.primaryGenreLabel,
		collectionIds: match.collectionIds,
		creatorIds: match.creatorIds,
	};
}
