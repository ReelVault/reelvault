import { describe, expect, test } from "bun:test";
import {
	type RecommendationFeatureRow,
	type RecommendationFeatureStats,
	recommendationFeatureKey,
} from "@/utils/recommendation-feature.utils";
import { type RecommendationCandidate, recommendationSimilarityScale, scoreRecommendationCandidate } from "./recommendation-score.utils";
import type { RecommendationSeedVector, RecommendationTasteProfile } from "./recommendation-taste.builder";
import { buildRecommendationItemVector, type RecommendationItemVector } from "./recommendation-vector.builder";

const MEAN_RATING = 8;
const NOW = 1_767_225_600_000;
/** A profile whose matches are all weak, so the scale floor applies: resemblance thresholds 0.10, 0.067 and 0.15. */
const CONTEXT = { nowMs: NOW, meanRating: MEAN_RATING, similarityScale: 1 / 3 };

function feature(kind: RecommendationFeatureRow["kind"], id: string): RecommendationFeatureRow {
	return { metadataId: "title", kind, id, label: id };
}

function catalogStats(documentFrequency: ReadonlyMap<string, number>): RecommendationFeatureStats {
	return { totalTitles: 100, documentFrequency, globalMeanRating: MEAN_RATING };
}

function candidate(overrides: Partial<RecommendationCandidate> = {}): RecommendationCandidate {
	return {
		id: "candidate",
		type: "movie",
		popularity: 0,
		releaseDate: "2000-01-01",
		createdAt: null,
		latestMediaCreatedAt: null,
		ratingValue: 8,
		ratingVotes: 50,
		...overrides,
	};
}

function seedVector(weights: ReadonlyArray<readonly [string, number]>): RecommendationSeedVector {
	return {
		seed: { metadataId: "seed", type: "movie", weight: 1, watchlistOnly: false },
		vector: { metadataId: "seed", weights: new Map(weights), norm: 1, features: new Map() },
	};
}

function profile(
	positiveVector: RecommendationItemVector,
	overrides: Partial<RecommendationTasteProfile> = {},
): RecommendationTasteProfile {
	return {
		positiveVector,
		evidenceVector: positiveVector,
		negativeVector: null,
		typeShare: { movie: 1, tv_show: 0 },
		seedCount: 1,
		confidence: 1,
		seedVectors: [],
		positiveFeatures: [],
		specificFeatureCount: 2,
		preferredYear: null,
		totalTitles: 100,
		...overrides,
		// The test seeds carry theme keys only, so their theme vectors are the same vectors.
		seedThemeVectors: overrides.seedThemeVectors ?? overrides.seedVectors ?? [],
	};
}

describe("recommendation candidate qualification", () => {
	test("rejects a candidate whose only shared evidence is a broad genre", () => {
		const drama = recommendationFeatureKey("genre", "drama");
		const vector = buildRecommendationItemVector("title", [feature("genre", "drama")], catalogStats(new Map([[drama, 80]])));

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector), CONTEXT);

		expect(result.qualifies).toBeFalse();
		expect(result.themeCount).toBe(0);
		expect(result.sharedGenres).toBe(1);
	});

	test("accepts a candidate sharing one highly specific keyword with a watched title", () => {
		const theme = recommendationFeatureKey("keyword", "neo-noir");
		const vector = buildRecommendationItemVector("title", [feature("keyword", "neo-noir")], catalogStats(new Map([[theme, 2]])));
		const watched = seedVector([
			[theme, 0.1],
			["keyword\u0000other", 0.99498743710662],
		]);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector, { seedVectors: [watched] }), CONTEXT);

		expect(result.qualifies).toBeTrue();
		expect(result.strongThemeCount).toBe(1);
		expect(result.themeCount).toBe(1);
		expect(result.specificScore).toBeCloseTo(0.7662024614, 8);
	});

	test("rejects a rare tag as the only link when the title resembles no watched title", () => {
		// A rare mood tag ("brisk") is as specific as a real subject, so the
		// tag alone must not qualify a title that looks like nothing watched.
		const theme = recommendationFeatureKey("keyword", "brisk");
		const vector = buildRecommendationItemVector("title", [feature("keyword", "brisk")], catalogStats(new Map([[theme, 2]])));
		const unrelated = seedVector([
			[theme, 0.05],
			["keyword\u0000other", 0.998749217771909],
		]);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector, { seedVectors: [unrelated] }), CONTEXT);

		expect(result.maxSeedSimilarity).toBeCloseTo(0.05, 10);
		expect(result.strongThemeCount).toBe(1);
		expect(result.qualifies).toBeFalse();
	});

	test("rejects a candidate with a single medium-specificity theme and no similar seed", () => {
		const theme = recommendationFeatureKey("keyword", "theme");
		const vector = buildRecommendationItemVector("title", [feature("keyword", "theme")], catalogStats(new Map([[theme, 8]])));
		const disjoint = seedVector([[recommendationFeatureKey("keyword", "street-racing"), 1]]);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector, { seedVectors: [disjoint] }), CONTEXT);

		expect(result.maxSeedSimilarity).toBe(0);
		expect(result.qualifies).toBeFalse();
		expect(result.themeCount).toBe(1);
		expect(result.strongThemeCount).toBe(0);
	});
});

describe("multi-theme qualification", () => {
	test("rejects a candidate whose only links are two broad mood tags", () => {
		const first = recommendationFeatureKey("keyword", "intimate");
		const second = recommendationFeatureKey("keyword", "compassionate");
		const stats = catalogStats(
			new Map([
				[first, 8],
				[second, 8],
			]),
		);
		const vector = buildRecommendationItemVector("title", [feature("keyword", "intimate"), feature("keyword", "compassionate")], stats);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector), CONTEXT);

		expect(result.themeCount).toBe(2);
		expect(result.specificScore).toBeCloseTo(1.080848613, 8);
		expect(result.qualifies).toBeFalse();
	});

	test("accepts a candidate sharing two near-strong themes", () => {
		const first = recommendationFeatureKey("keyword", "racing");
		const second = recommendationFeatureKey("keyword", "cars");
		const stats = catalogStats(
			new Map([
				[first, 4],
				[second, 4],
			]),
		);
		const vector = buildRecommendationItemVector("title", [feature("keyword", "racing"), feature("keyword", "cars")], stats);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector), CONTEXT);

		expect(result.themeCount).toBe(2);
		expect(result.strongThemeCount).toBe(0);
		expect(result.specificScore).toBeCloseTo(1.319368552, 8);
		expect(result.qualifies).toBeTrue();
	});
});

describe("recommendation seed evidence qualification", () => {
	test("accepts a candidate close to a seed without any shared theme", () => {
		const drama = recommendationFeatureKey("genre", "drama");
		const vector = buildRecommendationItemVector("title", [feature("genre", "drama")], catalogStats(new Map([[drama, 80]])));
		const close = seedVector([
			[drama, 0.2],
			["keyword\u0000other", 0.9797958971132712],
		]);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector, { seedVectors: [close] }), CONTEXT);

		expect(result.maxSeedSimilarity).toBeCloseTo(0.2, 10);
		expect(result.themeCount).toBe(0);
		expect(result.qualifies).toBeTrue();
	});

	test("accepts one theme paired with a seed similarity at the threshold", () => {
		const theme = recommendationFeatureKey("keyword", "theme");
		const vector = buildRecommendationItemVector("title", [feature("keyword", "theme")], catalogStats(new Map([[theme, 6]])));
		const modest = seedVector([
			[theme, 0.1],
			["keyword\u0000other", 0.99498743710662],
		]);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector, { seedVectors: [modest] }), CONTEXT);

		expect(result.maxSeedSimilarity).toBeCloseTo(0.1, 10);
		expect(result.bestThemeSpecificity).toBeCloseTo(0.590866192, 8);
		expect(result.themeCount).toBe(1);
		expect(result.qualifies).toBeTrue();
	});

	test("accepts a strong seed match with no shared theme", () => {
		const drama = recommendationFeatureKey("genre", "drama");
		const vector = buildRecommendationItemVector("title", [feature("genre", "drama")], catalogStats(new Map([[drama, 80]])));
		const strong = seedVector([
			[drama, 0.15],
			["keyword\u0000other", 0.9886859966642595],
		]);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector, { seedVectors: [strong] }), CONTEXT);

		expect(result.maxSeedSimilarity).toBeCloseTo(0.15, 10);
		expect(result.themeCount).toBe(0);
		expect(result.qualifies).toBeTrue();
	});
});

describe("recommendation cast evidence qualification", () => {
	test("rejects two shared cast members without a shared theme", () => {
		const first = recommendationFeatureKey("cast", "actor-first");
		const second = recommendationFeatureKey("cast", "actor-second");
		const stats = catalogStats(
			new Map([
				[first, 1],
				[second, 1],
			]),
		);
		const vector = buildRecommendationItemVector("title", [feature("cast", "actor-first"), feature("cast", "actor-second")], stats);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector), CONTEXT);

		expect(result.qualifies).toBeFalse();
		expect(result.castEvidence).toBeCloseTo(0.8519443032, 8);
		expect(result.themeCount).toBe(0);
	});

	test("accepts two shared cast members alongside one shared theme", () => {
		const first = recommendationFeatureKey("cast", "actor-first");
		const second = recommendationFeatureKey("cast", "actor-second");
		const theme = recommendationFeatureKey("keyword", "theme");
		const stats = catalogStats(
			new Map([
				[first, 1],
				[second, 1],
				[theme, 8],
			]),
		);
		const vector = buildRecommendationItemVector(
			"title",
			[feature("cast", "actor-first"), feature("cast", "actor-second"), feature("keyword", "theme")],
			stats,
		);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector), CONTEXT);

		expect(result.castEvidence).toBeCloseTo(0.8519443032, 8);
		expect(result.themeCount).toBe(1);
		expect(result.qualifies).toBeTrue();
	});
});

describe("crew credit evidence qualification", () => {
	function creditVector(role: string): RecommendationItemVector {
		const key = recommendationFeatureKey("credit", "person");
		const theme = recommendationFeatureKey("keyword", "theme");
		const stats = {
			...catalogStats(
				new Map([
					[key, 1],
					[theme, 8],
				]),
			),
			roleWeights: new Map([
				["Reżyseria", 1],
				["Scenografia", 0.3],
			]),
		};

		return buildRecommendationItemVector(
			"title",
			[{ metadataId: "title", kind: "credit", id: "person", label: "person", role }, feature("keyword", "theme")],
			stats,
		);
	}

	test("accepts a title sharing a one-per-title credit when its themes resemble a watched title", () => {
		const vector = creditVector("Reżyseria");
		const watched = seedVector([
			[recommendationFeatureKey("keyword", "theme"), 0.1],
			["keyword\u0000other", 0.99498743710662],
		]);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector, { seedVectors: [watched] }), CONTEXT);

		expect(result.maxSeedSimilarity).toBeCloseTo(0.1, 10);
		expect(result.strongThemeCount).toBe(1);
		expect(result.creatorIds).toEqual(["person"]);
		expect(result.qualifies).toBeTrue();
	});

	test("does not count a credit in a weakly informative job as a theme", () => {
		const vector = creditVector("Scenografia");

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector), CONTEXT);

		// Specificity 0.85 × role weight 0.3 sits below the 0.45 theme floor; only the medium keyword counts.
		expect(result.themeCount).toBe(1);
		expect(result.creatorIds).toEqual([]);
		expect(result.qualifies).toBeFalse();
	});
});

describe("recommendation seed similarity boundaries", () => {
	test("rejects one theme with a seed similarity just below the threshold", () => {
		const theme = recommendationFeatureKey("keyword", "theme");
		const vector = buildRecommendationItemVector("title", [feature("keyword", "theme")], catalogStats(new Map([[theme, 6]])));
		const below = seedVector([
			[theme, 0.099],
			["keyword\u0000other", 0.9950874333444273],
		]);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector, { seedVectors: [below] }), CONTEXT);

		expect(result.maxSeedSimilarity).toBeCloseTo(0.099, 10);
		expect(result.bestThemeSpecificity).toBeCloseTo(0.590866192, 8);
		expect(result.themeCount).toBe(1);
		expect(result.qualifies).toBeFalse();
	});

	test("reports low theme specificity as a diagnostic without gating on it", () => {
		const theme = recommendationFeatureKey("keyword", "theme");
		const vector = buildRecommendationItemVector("title", [feature("keyword", "theme")], catalogStats(new Map([[theme, 8]])));
		const modest = seedVector([
			[theme, 0.1],
			["keyword\u0000other", 0.99498743710662],
		]);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector, { seedVectors: [modest] }), CONTEXT);

		expect(result.bestThemeSpecificity).toBeCloseTo(0.5404243065, 8);
		expect(result.maxSeedSimilarity).toBeCloseTo(0.1, 10);
		expect(result.qualifies).toBeTrue();
	});

	test("rejects a single-theme movie for a TV-heavy profile", () => {
		const strongTheme = recommendationFeatureKey("keyword", "neo-noir");
		const vector = buildRecommendationItemVector("title", [feature("keyword", "neo-noir")], catalogStats(new Map([[strongTheme, 2]])));
		const tvHeavy = profile(vector, { typeShare: { movie: 0.14, tv_show: 0.86 } });

		const result = scoreRecommendationCandidate(candidate(), vector, tvHeavy, CONTEXT);

		expect(result.themeCount).toBe(1);
		expect(result.bestThemeSpecificity).toBeCloseTo(0.7662024614, 8);
		expect(result.qualifies).toBeFalse();
	});

	test("accepts a strong minority match for a TV-heavy profile", () => {
		const drama = recommendationFeatureKey("genre", "drama");
		const vector = buildRecommendationItemVector("title", [feature("genre", "drama")], catalogStats(new Map([[drama, 80]])));
		const tvHeavy = profile(vector, { typeShare: { movie: 0.14, tv_show: 0.86 } });
		const strong = seedVector([
			[drama, 0.15],
			["keyword\u0000other", 0.9886859966642595],
		]);

		const result = scoreRecommendationCandidate(
			candidate(),
			vector,
			profile(tvHeavy.positiveVector, { typeShare: tvHeavy.typeShare, seedVectors: [strong] }),
			CONTEXT,
		);

		expect(result.maxSeedSimilarity).toBeCloseTo(0.15, 10);
		expect(result.themeCount).toBe(0);
		expect(result.qualifies).toBeTrue();
	});

	test("rejects a seed similarity that is too weak without a theme", () => {
		const drama = recommendationFeatureKey("genre", "drama");
		const vector = buildRecommendationItemVector("title", [feature("genre", "drama")], catalogStats(new Map([[drama, 80]])));
		const weak = seedVector([
			[drama, 0.08],
			["keyword\u0000other", 0.996794863550169],
		]);

		const result = scoreRecommendationCandidate(candidate(), vector, profile(vector, { seedVectors: [weak] }), CONTEXT);

		expect(result.maxSeedSimilarity).toBeCloseTo(0.08, 10);
		expect(result.themeCount).toBe(0);
		expect(result.qualifies).toBeFalse();
	});
});

describe("recommendation score factors", () => {
	test("lowers the score when the profile dislikes the candidate's features", () => {
		const drama = recommendationFeatureKey("genre", "drama");
		const vector = buildRecommendationItemVector("title", [feature("genre", "drama")], catalogStats(new Map([[drama, 80]])));

		const neutral = scoreRecommendationCandidate(candidate(), vector, profile(vector), CONTEXT);
		const disliked = scoreRecommendationCandidate(candidate(), vector, profile(vector, { negativeVector: vector }), CONTEXT);

		// Content 0.55 (and 0.25 with the dislike) times the prior factor 0.7 + 0.3 × (0.8 × 0.05 + 0.5 × 0.02) / 0.09.
		expect(neutral.score).toBeCloseTo(0.4766666667, 8);
		expect(disliked.score).toBeCloseTo(0.2166666667, 8);
	});

	test("scores a TV title above an identical movie for a TV-leaning profile", () => {
		const drama = recommendationFeatureKey("genre", "drama");
		const vector = buildRecommendationItemVector("title", [feature("genre", "drama")], catalogStats(new Map([[drama, 80]])));
		const tvProfile = profile(vector, { typeShare: { movie: 0.2, tv_show: 0.8 } });

		const movieScore = scoreRecommendationCandidate(candidate({ id: "movie", type: "movie" }), vector, tvProfile, CONTEXT);
		const tvScore = scoreRecommendationCandidate(candidate({ id: "show", type: "tv_show" }), vector, tvProfile, CONTEXT);

		expect(tvScore.score).toBeCloseTo(0.4623666667, 8);
		expect(movieScore.score).toBeCloseTo(0.4194666667, 8);
	});

	test("lifts a multi-theme candidate above a single-theme one through shared specificity", () => {
		const first = recommendationFeatureKey("keyword", "first");
		const second = recommendationFeatureKey("keyword", "second");
		const stats = catalogStats(
			new Map([
				[first, 2],
				[second, 2],
			]),
		);
		const both = buildRecommendationItemVector("both", [feature("keyword", "first"), feature("keyword", "second")], stats);
		const one = buildRecommendationItemVector("one", [feature("keyword", "first")], stats);

		const single = scoreRecommendationCandidate(candidate({ id: "one" }), one, profile(both), CONTEXT);
		const multi = scoreRecommendationCandidate(candidate({ id: "both" }), both, profile(both), CONTEXT);

		expect(single.score).toBeCloseTo(0.350335075, 8);
		expect(multi.score).toBeCloseTo(0.494, 8);
	});
});

describe("genre and resemblance gates", () => {
	test("rejects a title that shares strong tags but no genre with the profile", () => {
		const drama = recommendationFeatureKey("genre", "drama");
		const family = recommendationFeatureKey("genre", "family");
		const tag = recommendationFeatureKey("keyword", "commanding");
		const stats = catalogStats(
			new Map([
				[drama, 40],
				[family, 40],
				[tag, 2],
			]),
		);
		const profileVector = buildRecommendationItemVector("profile", [feature("genre", "drama"), feature("keyword", "commanding")], stats);
		const animated = buildRecommendationItemVector("animated", [feature("genre", "family"), feature("keyword", "commanding")], stats);
		const watched = seedVector([
			[tag, 0.9],
			[drama, 0.4358898943540674],
		]);

		const result = scoreRecommendationCandidate(candidate(), animated, profile(profileVector, { seedVectors: [watched] }), CONTEXT);

		expect(result.strongThemeCount).toBe(1);
		expect(result.sharedGenres).toBe(0);
		expect(result.qualifies).toBeFalse();
	});

	test("judges one shared theme against the profile's best resemblance, not a fixed value", () => {
		const theme = recommendationFeatureKey("keyword", "theme");
		const vector = buildRecommendationItemVector("title", [feature("keyword", "theme")], catalogStats(new Map([[theme, 6]])));
		const modest = seedVector([
			[theme, 0.12],
			["keyword\u0000other", 0.9927738916792685],
		]);
		const withSeed = profile(vector, { seedVectors: [modest] });

		const weakProfile = scoreRecommendationCandidate(candidate(), vector, withSeed, CONTEXT);
		// A profile whose best candidate resembles a watched title at 0.48 asks for 0.3 × 0.48 = 0.144.
		const strongProfile = scoreRecommendationCandidate(candidate(), vector, withSeed, { ...CONTEXT, similarityScale: 0.48 });

		expect(weakProfile.qualifies).toBeTrue();
		expect(strongProfile.qualifies).toBeFalse();
	});

	test("floors the similarity scale for a profile with only weak matches", () => {
		const theme = recommendationFeatureKey("keyword", "theme");
		const vector = buildRecommendationItemVector("title", [feature("keyword", "theme")], catalogStats(new Map([[theme, 6]])));
		const close = { seed: { metadataId: "seed", type: "movie" as const, weight: 1, watchlistOnly: false }, vector };
		const far = seedVector([["keyword\u0000other", 1]]);

		expect(recommendationSimilarityScale([vector], profile(vector, { seedVectors: [close] }))).toBeCloseTo(1, 10);
		expect(recommendationSimilarityScale([vector], profile(vector, { seedVectors: [far] }))).toBeCloseTo(0.3333333333, 8);
	});
});
