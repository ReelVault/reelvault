import { describe, expect, test } from "bun:test";
import { type RecommendationFeatureStats, recommendationFeatureKey } from "@/utils/recommendation-feature.utils";
import type { RecommendationSeedSet } from "./recommendation-seed.builder";
import { buildRecommendationTasteProfile, maximumSeedSimilarity, type RecommendationSeedVector } from "./recommendation-taste.builder";
import { buildRecommendationItemVector, type RecommendationItemVector } from "./recommendation-vector.builder";

function vector(weights: ReadonlyArray<readonly [string, number]>): RecommendationItemVector {
	return { metadataId: "title", weights: new Map(weights), norm: 1, features: new Map() };
}

function seedVector(weights: ReadonlyArray<readonly [string, number]>): RecommendationSeedVector {
	return {
		seed: { metadataId: "seed", type: "movie", weight: 1, watchlistOnly: false },
		vector: vector(weights),
	};
}

describe("maximum seed similarity", () => {
	test("returns full similarity for a vector identical to a seed", () => {
		const shared = recommendationFeatureKey("keyword", "medical-drama");
		const candidate = vector([[shared, 1]]);

		expect(maximumSeedSimilarity(candidate, [seedVector([[shared, 1]])])).toBe(1);
	});

	test("returns zero similarity for a vector disjoint from every seed", () => {
		const candidate = vector([[recommendationFeatureKey("keyword", "medical-drama"), 1]]);
		const seed = seedVector([[recommendationFeatureKey("keyword", "street-racing"), 1]]);

		expect(maximumSeedSimilarity(candidate, [seed])).toBe(0);
	});
});

describe("taste profile vectors", () => {
	const stats: RecommendationFeatureStats = {
		totalTitles: 100,
		documentFrequency: new Map([
			[recommendationFeatureKey("keyword", "heist"), 2],
			[recommendationFeatureKey("credit", "nolan"), 2],
		]),
		globalMeanRating: 6.5,
		roleWeights: new Map([["Director", 0.92]]),
	};
	const seedVectorOf = buildRecommendationItemVector(
		"seed",
		[
			{ metadataId: "seed", kind: "keyword", id: "heist", label: "heist" },
			{ metadataId: "seed", kind: "credit", id: "nolan", label: "Christopher Nolan", role: "Director" },
		],
		stats,
	);
	const seedSet: RecommendationSeedSet = {
		positive: [{ metadataId: "seed", type: "movie", weight: 1, watchlistOnly: false }],
		watchlist: [],
		negative: [],
		typeShare: { movie: 1, tv_show: 0 },
		watchedWeight: 1,
		watchlistWeight: 0,
		preferredYear: null,
	};

	test("keeps credits out of the taste centroid but in the evidence vector", () => {
		const profile = buildRecommendationTasteProfile(seedSet, new Map([["seed", seedVectorOf]]), stats.totalTitles);
		const director = recommendationFeatureKey("credit", "nolan");

		expect(profile?.positiveVector.features.has(director)).toBeFalse();
		expect(profile?.evidenceVector.features.has(director)).toBeTrue();
		expect(profile?.positiveFeatures.some((feature) => feature.kind === "credit")).toBeTrue();
	});
});
