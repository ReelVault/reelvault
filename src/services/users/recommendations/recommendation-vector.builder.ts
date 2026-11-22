import {
	inverseDocumentFrequency,
	normalizeRecommendationVector,
	type RecommendationFeatureKind,
	type RecommendationFeatureRow,
	type RecommendationFeatureStats,
	recommendationFeatureKey,
	recommendationFeatureSpecificity,
} from "@/utils/recommendation-feature.utils";
import {
	RECOMMENDATION_FEATURE_TYPE_WEIGHTS,
	RECOMMENDATION_MAX_FEATURES_PER_TITLE,
	RECOMMENDATION_MAX_KEYWORDS_PER_TITLE,
} from "./recommendation.constants";

export interface WeightedRecommendationFeature extends RecommendationFeatureRow {
	key: string;
	idf: number;
	/** `idf / ln(1 + N)`: comparable across catalogs of different sizes and providers. */
	specificity: number;
	/** Keyword genre concentration (0..1); 1 for every other feature kind. */
	concentration: number;
	/** The crew job's catalog weight (0..1) for a credit; 1 for every other kind. */
	roleWeight: number;
	weight: number;
}

export interface RecommendationItemVector {
	metadataId: string;
	weights: Map<string, number>;
	norm: number;
	features: Map<string, WeightedRecommendationFeature>;
}

function featureWeight(feature: RecommendationFeatureRow, stats: RecommendationFeatureStats): WeightedRecommendationFeature {
	const key = recommendationFeatureKey(feature.kind, feature.id);
	const idf = inverseDocumentFrequency(stats.totalTitles, stats.documentFrequency.get(key) ?? 0);
	const concentration = feature.kind === "keyword" ? (stats.keywordConcentration?.get(key) ?? 1) : 1;
	const roleWeight = feature.kind === "credit" ? (stats.roleWeights?.get(feature.role ?? "") ?? 0) : 1;
	const multiplier = feature.kind === "keyword" ? 0.55 + 0.45 * concentration : roleWeight;

	return {
		metadataId: feature.metadataId,
		kind: feature.kind,
		id: feature.id,
		label: feature.label,
		role: feature.role ?? null,
		key,
		idf,
		specificity: recommendationFeatureSpecificity(idf, stats.totalTitles),
		concentration,
		roleWeight,
		weight: RECOMMENDATION_FEATURE_TYPE_WEIGHTS[feature.kind] * idf * multiplier,
	};
}

/** Per-kind ceilings applied while choosing the strongest features of one title. */
const FEATURE_SELECTION_CAPS: Partial<Record<RecommendationFeatureKind, number>> = {
	keyword: RECOMMENDATION_MAX_KEYWORDS_PER_TITLE,
	credit: 6,
};

function isFeatureCapped(feature: RecommendationFeatureRow, counts: ReadonlyMap<RecommendationFeatureKind, number>): boolean {
	const cap = FEATURE_SELECTION_CAPS[feature.kind];

	return cap !== undefined && (counts.get(feature.kind) ?? 0) >= cap;
}

function countFeature(feature: RecommendationFeatureRow, counts: Map<RecommendationFeatureKind, number>): void {
	const cap = FEATURE_SELECTION_CAPS[feature.kind];
	if (cap === undefined) return;

	counts.set(feature.kind, (counts.get(feature.kind) ?? 0) + 1);
}

/**
 * Keeps the strongest features of one title. A provider record can carry dozens
 * of keywords; without a cap the vector becomes a bag of noise whose norm
 * hides the few features that actually describe the title.
 */
function selectStrongestFeatures(features: WeightedRecommendationFeature[]): WeightedRecommendationFeature[] {
	const sorted = features.toSorted((left, right) => right.weight - left.weight);
	const selected: WeightedRecommendationFeature[] = [];
	const counts = new Map<RecommendationFeatureKind, number>();

	for (const feature of sorted) {
		if (isFeatureCapped(feature, counts)) continue;

		selected.push(feature);
		countFeature(feature, counts);

		if (selected.length >= RECOMMENDATION_MAX_FEATURES_PER_TITLE) break;
	}

	return selected;
}

/** Builds the L2-normalized feature vector of one title. */
export function buildRecommendationItemVector(
	metadataId: string,
	features: readonly RecommendationFeatureRow[],
	stats: RecommendationFeatureStats,
): RecommendationItemVector {
	const unique = new Map<string, WeightedRecommendationFeature>();

	for (const feature of features) {
		const weighted = featureWeight(feature, stats);
		if (weighted.idf <= 0 || weighted.weight <= 0) continue;

		// One person can hold several jobs on a title; the strongest one describes the credit.
		const existing = unique.get(weighted.key);
		if (!existing || weighted.weight > existing.weight) unique.set(weighted.key, weighted);
	}

	const selected = selectStrongestFeatures([...unique.values()]);
	const normalized = normalizeRecommendationVector(new Map(selected.map((feature) => [feature.key, feature.weight])));
	const weightedFeatures = new Map<string, WeightedRecommendationFeature>();

	for (const feature of selected) {
		const weight = normalized.weights.get(feature.key);
		if (weight === undefined) continue;

		weightedFeatures.set(feature.key, { ...feature, weight });
	}

	return { metadataId, weights: normalized.weights, norm: normalized.norm, features: weightedFeatures };
}

/**
 * Sums several item vectors with the given seed weights and normalizes the
 * result. Used for the positive taste profile and the negative ("not
 * interested") profile.
 */
export function combineRecommendationVectors(
	metadataId: string,
	entries: ReadonlyArray<{ vector: RecommendationItemVector; weight: number }>,
): RecommendationItemVector {
	const weights = new Map<string, number>();
	const features = new Map<string, WeightedRecommendationFeature>();

	for (const entry of entries) {
		if (entry.weight <= 0) continue;

		for (const [key, weight] of entry.vector.weights) {
			weights.set(key, (weights.get(key) ?? 0) + weight * entry.weight);
			const feature = entry.vector.features.get(key);
			if (feature) features.set(key, feature);
		}
	}

	const normalized = normalizeRecommendationVector(weights);
	const weightedFeatures = new Map<string, WeightedRecommendationFeature>();

	for (const [key, weight] of normalized.weights) {
		const feature = features.get(key);
		if (!feature) continue;

		weightedFeatures.set(key, { ...feature, weight });
	}

	return { metadataId, weights: normalized.weights, norm: normalized.norm, features: weightedFeatures };
}

/** Strongest features of a profile, used to generate candidates. */
export function topRecommendationFeatures(vector: RecommendationItemVector, limit: number): WeightedRecommendationFeature[] {
	return [...vector.features.values()].toSorted((left, right) => right.weight - left.weight).slice(0, limit);
}
