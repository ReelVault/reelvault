import { describe, expect, test } from "bun:test";
import {
	type RecommendationFeatureKind,
	type RecommendationFeatureStats,
	recommendationFeatureKey,
} from "@/utils/recommendation-feature.utils";
import { buildRecommendationReason, reasonSeedIds } from "./recommendation-reasons.builder";
import type { RecommendationScore } from "./recommendation-score.utils";
import type { RecommendationTasteProfile } from "./recommendation-taste.builder";
import { buildRecommendationItemVector, type RecommendationItemVector } from "./recommendation-vector.builder";

interface TestFeature {
	kind: RecommendationFeatureKind;
	id: string;
	label: string | null;
	role?: string;
}

function vectorWith(metadataId: string, features: readonly TestFeature[], frequencyById: Record<string, number>): RecommendationItemVector {
	const stats: RecommendationFeatureStats = {
		totalTitles: 100,
		documentFrequency: new Map(
			features.map((feature) => [recommendationFeatureKey(feature.kind, feature.id), frequencyById[feature.id] ?? 1] as const),
		),
		globalMeanRating: 6.5,
		roleWeights: new Map([["Reżyseria", 1]]),
	};

	return buildRecommendationItemVector(
		metadataId,
		features.map((feature) => ({ ...feature, metadataId })),
		stats,
	);
}

function profileWith(vector: RecommendationItemVector): RecommendationTasteProfile {
	return {
		positiveVector: vector,
		evidenceVector: vector,
		negativeVector: null,
		typeShare: { movie: 1, tv_show: 0 },
		seedCount: 1,
		confidence: 1,
		seedVectors: [],
		seedThemeVectors: [],
		positiveFeatures: [...vector.features.values()],
		specificFeatureCount: vector.features.size,
		preferredYear: null,
		totalTitles: 100,
	};
}

function scoreWith(vector: RecommendationItemVector, overrides: Partial<RecommendationScore> = {}): RecommendationScore {
	return {
		candidate: {
			id: "candidate",
			type: "movie",
			popularity: 1,
			releaseDate: "2020-01-01",
			createdAt: null,
			latestMediaCreatedAt: null,
			ratingValue: null,
			ratingVotes: null,
		},
		vector,
		score: 0.5,
		qualifies: true,
		profileSimilarity: 0,
		seedSimilarity: 0,
		maxSeedSimilarity: 0,
		topSeedId: null,
		negativeSimilarity: 0,
		quality: 0.5,
		freshness: 0,
		era: 0.5,
		typeAffinity: 1,
		specificScore: 0,
		themeCount: 0,
		strongThemeCount: 0,
		bestThemeSpecificity: 0,
		castEvidence: 0,
		sharedGenres: 0,
		primaryGenreId: null,
		primaryGenreLabel: null,
		collectionIds: [],
		creatorIds: [],
		...overrides,
	};
}

const NO_SEEDS = new Map<string, string>();

describe("recommendation reasons", () => {
	test.each([
		{ kind: "keyword", label: "Space Opera", reason: "keyword" },
		{ kind: "cast", label: "Ada Lovelace", reason: "person" },
		{ kind: "collection", label: "The Archive", reason: "collection" },
	] as const satisfies ReadonlyArray<{ kind: RecommendationFeatureKind; label: string; reason: string }>)(
		"names a shared $kind feature with the provider label",
		({ kind, label, reason }) => {
			const feature: TestFeature = { kind, id: kind, label };
			const vector = vectorWith("candidate", [feature], { [kind]: 1 });
			const profile = profileWith(vectorWith("profile", [feature], { [kind]: 1 }));

			expect(buildRecommendationReason(scoreWith(vector), profile, NO_SEEDS)).toEqual({ metadataId: "candidate", kind: reason, label });
		},
	);

	test("names a shared credit with the provider's own job name over a shared theme", () => {
		const features: TestFeature[] = [
			{ kind: "keyword", id: "rare", label: "Rare Tag" },
			{ kind: "credit", id: "director", label: "Grace Hopper", role: "Reżyseria" },
		];
		const frequencies = { rare: 1, director: 3 };
		const candidate = vectorWith("candidate", features, frequencies);
		const profile = profileWith(vectorWith("profile", features, frequencies));

		expect(buildRecommendationReason(scoreWith(candidate), profile, NO_SEEDS)).toEqual({
			metadataId: "candidate",
			kind: "credit",
			label: "Grace Hopper",
			role: "Reżyseria",
		});
	});

	test("names a shared keyword rather than a rarer one the profile never watched", () => {
		const features: TestFeature[] = [
			{ kind: "keyword", id: "rare", label: "Rare Tag" },
			{ kind: "keyword", id: "common", label: "Common Tag" },
		];
		const candidate = vectorWith("candidate", features, { rare: 1, common: 5 });
		const profileVector = vectorWith("profile", [features[1] as TestFeature], { common: 5 });

		expect(buildRecommendationReason(scoreWith(candidate), profileWith(profileVector), NO_SEEDS)).toEqual({
			metadataId: "candidate",
			kind: "keyword",
			label: "Common Tag",
		});
	});

	test("names a close watched title when no credit is shared", () => {
		const feature: TestFeature = { kind: "keyword", id: "theme", label: "Theme" };
		const candidate = vectorWith("candidate", [feature], { theme: 1 });
		const profile = profileWith(vectorWith("profile", [feature], { theme: 1 }));
		const entry = scoreWith(candidate, { topSeedId: "seed-1", maxSeedSimilarity: 0.8 });

		expect(reasonSeedIds([entry])).toEqual(["seed-1"]);
		expect(buildRecommendationReason(entry, profile, new Map([["seed-1", "Arrival"]]))).toEqual({
			metadataId: "candidate",
			kind: "seed",
			label: "Arrival",
			seedId: "seed-1",
		});
	});

	test("does not name a weakly similar watched title", () => {
		const entry = scoreWith(vectorWith("candidate", [], {}), { topSeedId: "seed-1", maxSeedSimilarity: 0.1 });

		expect(reasonSeedIds([entry])).toEqual([]);
	});

	test("falls back to the primary genre when no specific feature is shared", () => {
		const candidate = vectorWith("candidate", [{ kind: "genre", id: "genre", label: "Drama" }], { genre: 70 });
		const profile = profileWith(vectorWith("profile", [], {}));

		expect(buildRecommendationReason(scoreWith(candidate, { primaryGenreLabel: "Drama" }), profile, NO_SEEDS)).toEqual({
			metadataId: "candidate",
			kind: "genre",
			label: "Drama",
		});
	});

	test("explains a cold-start slate as library popularity", () => {
		const candidate = vectorWith("candidate", [{ kind: "keyword", id: "keyword", label: "Space Opera" }], { keyword: 1 });

		expect(buildRecommendationReason(scoreWith(candidate), null, NO_SEEDS)).toEqual({ metadataId: "candidate", kind: "popular" });
	});
});
