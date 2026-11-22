import type { RecommendationReason, RecommendationReasonKind } from "@reelvault/sdk/common";
import type { RecommendationFeatureKind } from "@/utils/recommendation-feature.utils";
import { RECOMMENDATION_REASON_SEED_SIMILARITY, RECOMMENDATION_THEME_SPECIFICITY } from "./recommendation.constants";
import type { RecommendationScore } from "./recommendation-score.utils";
import type { RecommendationTasteProfile } from "./recommendation-taste.builder";

const REASON_KIND_OF_FEATURE: Partial<Record<RecommendationFeatureKind, RecommendationReasonKind>> = {
	collection: "collection",
	credit: "credit",
	cast: "person",
	keyword: "keyword",
};

interface SharedFeature {
	label: string;
	/** The provider's job name, for a credit. */
	role: string | null;
	contribution: number;
}

/**
 * The strongest shared, labelled feature of each reason kind. Strength is the
 * feature's share of the match (candidate weight × profile weight), so the
 * reason names what actually drove the score, not merely the rarest tag.
 */
function strongestSharedFeatures(
	entry: RecommendationScore,
	profile: RecommendationTasteProfile,
): Map<RecommendationReasonKind, SharedFeature> {
	const strongest = new Map<RecommendationReasonKind, SharedFeature>();

	for (const [key, feature] of entry.vector.features) {
		const kind = REASON_KIND_OF_FEATURE[feature.kind];
		if (kind === undefined || feature.label === null) continue;
		if (feature.kind !== "collection" && feature.specificity * feature.roleWeight < RECOMMENDATION_THEME_SPECIFICITY) continue;

		const evidence = profile.evidenceVector.features.get(key);
		if (!evidence) continue;

		const contribution = feature.weight * evidence.weight;
		const current = strongest.get(kind);
		if (!current || contribution > current.contribution) {
			strongest.set(kind, { label: feature.label, role: feature.role ?? null, contribution });
		}
	}

	return strongest;
}

/**
 * One reason per recommendation, as a kind plus the provider label; clients
 * build the sentence in their own language. Order of preference: the same
 * franchise, a shared crew credit (with the provider's job name), a close watched
 * title, a shared cast member, a shared theme, then the main shared genre.
 */
export function buildRecommendationReason(
	entry: RecommendationScore,
	profile: RecommendationTasteProfile | null,
	seedTitles: ReadonlyMap<string, string>,
): RecommendationReason {
	const metadataId = entry.candidate.id;
	if (profile === null) return { metadataId, kind: "popular" };

	const shared = strongestSharedFeatures(entry, profile);
	const collection = shared.get("collection");
	if (collection) return { metadataId, kind: "collection", label: collection.label };

	const credit = shared.get("credit");
	if (credit)
		return credit.role === null
			? { metadataId, kind: "credit", label: credit.label }
			: { metadataId, kind: "credit", label: credit.label, role: credit.role };

	const seedTitle = entry.topSeedId === null ? undefined : seedTitles.get(entry.topSeedId);
	if (entry.topSeedId !== null && seedTitle !== undefined && entry.maxSeedSimilarity >= RECOMMENDATION_REASON_SEED_SIMILARITY) {
		return { metadataId, kind: "seed", label: seedTitle, seedId: entry.topSeedId };
	}

	for (const kind of ["person", "keyword"] as const) {
		const feature = shared.get(kind);
		if (feature) return { metadataId, kind, label: feature.label };
	}

	if (entry.primaryGenreLabel !== null) return { metadataId, kind: "genre", label: entry.primaryGenreLabel };

	return { metadataId, kind: "taste" };
}

/** Seeds a "Because you watched" reason may name; the caller loads their titles. */
export function reasonSeedIds(entries: readonly RecommendationScore[]): string[] {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.topSeedId !== null && entry.maxSeedSimilarity >= RECOMMENDATION_REASON_SEED_SIMILARITY) ids.add(entry.topSeedId);
	}

	return [...ids];
}

export function buildRecommendationReasons(
	entries: readonly RecommendationScore[],
	profile: RecommendationTasteProfile | null,
	seedTitles: ReadonlyMap<string, string>,
): RecommendationReason[] {
	return entries.map((entry) => buildRecommendationReason(entry, profile, seedTitles));
}
