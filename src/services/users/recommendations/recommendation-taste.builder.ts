import type { MetadataType } from "@reelvault/sdk/common";
import { cosineSimilarity, normalizeRecommendationVector, type RecommendationFeatureKind } from "@/utils/recommendation-feature.utils";
import { RECOMMENDATION_MIN_SEED_WEIGHT, RECOMMENDATION_THEME_SPECIFICITY } from "./recommendation.constants";
import { type RecommendationSeed, type RecommendationSeedSet, typeShareOf } from "./recommendation-seed.builder";
import {
	combineRecommendationVectors,
	type RecommendationItemVector,
	topRecommendationFeatures,
	type WeightedRecommendationFeature,
} from "./recommendation-vector.builder";

export interface RecommendationSeedVector {
	seed: RecommendationSeed;
	vector: RecommendationItemVector;
}

function isThemeKind(kind: RecommendationFeatureKind): boolean {
	return kind === "genre" || kind === "keyword" || kind === "collection";
}

/** The centroid carries taste (themes only); credits stay on the full seed vectors. */
export function themesOnlyVector(vector: RecommendationItemVector): RecommendationItemVector {
	const weights = new Map<string, number>();
	for (const [key, weight] of vector.weights) {
		const feature = vector.features.get(key);
		if (feature && isThemeKind(feature.kind)) weights.set(key, weight);
	}

	const normalized = normalizeRecommendationVector(weights);
	const features = new Map<string, WeightedRecommendationFeature>();
	for (const [key, weight] of normalized.weights) {
		const feature = vector.features.get(key);
		if (feature) features.set(key, { ...feature, weight });
	}

	return { ...vector, weights: normalized.weights, norm: normalized.norm, features };
}

export interface RecommendationTasteProfile {
	/** Themes-only centroid (genres, keywords, collections): the taste a candidate is compared with. */
	positiveVector: RecommendationItemVector;
	/**
	 * Centroid of the full seed vectors, credits included. Shared-evidence
	 * checks, candidate generation and reasons read it, so a director or cast
	 * member the profile keeps watching counts even though it is not a theme.
	 */
	evidenceVector: RecommendationItemVector;
	negativeVector: RecommendationItemVector | null;
	typeShare: Record<MetadataType, number>;
	seedCount: number;
	confidence: number;
	seedVectors: RecommendationSeedVector[];
	/**
	 * The same seeds reduced to their themes, in the same order. "Resembles a
	 * watched title" is judged on these, so it does not depend on how many crew
	 * and cast a provider lists (TMDB lists about a hundred people, others a few).
	 */
	seedThemeVectors: RecommendationSeedVector[];
	/** Strongest evidence features of every kind; candidate generation reads them. */
	positiveFeatures: WeightedRecommendationFeature[];
	specificFeatureCount: number;
	preferredYear: number | null;
	totalTitles: number;
}

/**
 * Builds the content-based taste profile: a weighted centroid of the seed
 * vectors plus a separate negative centroid for explicit dislikes. The two are
 * never subtracted into one vector because a candidate can legitimately share
 * a genre with a disliked title while sharing a keyword with a loved one.
 */
export function buildRecommendationTasteProfile(
	seedSet: RecommendationSeedSet,
	vectorsByMetadataId: ReadonlyMap<string, RecommendationItemVector>,
	totalTitles: number,
): RecommendationTasteProfile | null {
	const positiveEntries: Array<{ vector: RecommendationItemVector; weight: number }> = [];
	const seedVectors: RecommendationSeedVector[] = [];
	const allSeeds = seedSet.positive.length > 0 ? seedSet.positive : seedSet.watchlist;
	const strongSeeds = allSeeds.filter((seed) => seed.weight >= RECOMMENDATION_MIN_SEED_WEIGHT);
	const seeds = strongSeeds.length > 0 ? strongSeeds : allSeeds;

	for (const seed of seeds) {
		const vector = vectorsByMetadataId.get(seed.metadataId);
		if (!vector || vector.norm === 0) continue;

		positiveEntries.push({ vector, weight: seed.weight });
		seedVectors.push({ seed, vector });
	}

	if (positiveEntries.length === 0) return null;

	const negativeEntries: Array<{ vector: RecommendationItemVector; weight: number }> = [];
	for (const seed of seedSet.negative) {
		const vector = vectorsByMetadataId.get(seed.metadataId);
		if (vector && vector.norm > 0) negativeEntries.push({ vector, weight: seed.weight });
	}

	let positiveVector = combineRecommendationVectors(
		"recommendation-profile",
		positiveEntries.map((entry) => ({ ...entry, vector: themesOnlyVector(entry.vector) })),
	);
	if (positiveVector.norm === 0) {
		positiveVector = combineRecommendationVectors("recommendation-profile", positiveEntries);
	}
	const evidenceVector = combineRecommendationVectors("recommendation-evidence", positiveEntries);
	let negativeVector: RecommendationItemVector | null = null;
	if (negativeEntries.length > 0) {
		negativeVector = combineRecommendationVectors("recommendation-negative-profile", negativeEntries);
	}
	const positiveFeatures = topRecommendationFeatures(evidenceVector, 80);
	const specificFeatureCount = positiveFeatures.filter(
		(feature) => feature.kind !== "genre" && feature.specificity >= RECOMMENDATION_THEME_SPECIFICITY,
	).length;

	seedVectors.sort((left, right) => right.seed.weight - left.seed.weight);
	const seedThemeVectors = seedVectors.map((entry) => ({ seed: entry.seed, vector: themesOnlyVector(entry.vector) }));

	return {
		positiveVector,
		evidenceVector,
		negativeVector,
		typeShare: typeShareOf(seeds),
		seedCount: positiveEntries.length,
		confidence: seedSet.positive.length > 0 ? Math.min(1, positiveEntries.length / 3) : Math.min(0.5, positiveEntries.length / 6),
		seedVectors,
		seedThemeVectors,
		positiveFeatures,
		specificFeatureCount,
		preferredYear: seedSet.preferredYear,
		totalTitles,
	};
}

/** Mean similarity to the strongest seeds: keeps distinct taste buckets alive. */
export function seedSimilarity(
	candidate: RecommendationItemVector,
	seedVectors: readonly RecommendationSeedVector[],
	limit: number,
): number {
	if (seedVectors.length === 0) return 0;

	const top: number[] = [];
	for (const entry of seedVectors) {
		const similarity = cosineSimilarity(candidate, entry.vector);
		if (top.length < limit) {
			top.push(similarity);
			top.sort((left, right) => left - right);
		} else if (similarity > (top[0] ?? 0)) {
			top[0] = similarity;
			top.sort((left, right) => left - right);
		}
	}

	if (top.length === 0) return 0;

	return top.reduce((sum, value) => sum + value, 0) / top.length;
}

/** Closest single seed, used both for qualification and for slate bucket coverage. */
export function closestSeed(
	candidate: RecommendationItemVector,
	seedVectors: readonly RecommendationSeedVector[],
): { id: string; similarity: number } | null {
	let best: { id: string; similarity: number } | null = null;
	for (const entry of seedVectors) {
		const similarity = cosineSimilarity(candidate, entry.vector);
		if (best === null || similarity > best.similarity) best = { id: entry.seed.metadataId, similarity };
	}

	return best;
}

/** Closest single seed similarity: a candidate can qualify by mirroring one loved title. */
export function maximumSeedSimilarity(candidate: RecommendationItemVector, seedVectors: readonly RecommendationSeedVector[]): number {
	return closestSeed(candidate, seedVectors)?.similarity ?? 0;
}
