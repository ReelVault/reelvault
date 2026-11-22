import { describe, expect, test } from "bun:test";
import type { MetadataType } from "@reelvault/sdk/common";
import { recommendationFeatureKey } from "@/utils/recommendation-feature.utils";
import type { RecommendationCandidate, RecommendationScore } from "./recommendation-score.utils";
import { buildRecommendationSlate } from "./recommendation-slate.builder";
import type { RecommendationItemVector } from "./recommendation-vector.builder";

function keyword(id: string): string {
	return recommendationFeatureKey("keyword", id);
}

function candidate(id: string, type: MetadataType = "movie"): RecommendationCandidate {
	return {
		id,
		type,
		popularity: 0,
		releaseDate: "2000-01-01",
		createdAt: null,
		latestMediaCreatedAt: null,
		ratingValue: null,
		ratingVotes: null,
	};
}

function entry(
	id: string,
	value: number,
	weights: ReadonlyArray<readonly [string, number]>,
	overrides: Partial<RecommendationScore> = {},
): RecommendationScore {
	const vector: RecommendationItemVector = {
		metadataId: id,
		weights: new Map(weights),
		norm: 1,
		features: new Map(),
	};

	return {
		candidate: candidate(id),
		vector,
		score: value,
		qualifies: true,
		profileSimilarity: 0,
		seedSimilarity: 0,
		maxSeedSimilarity: 0,
		topSeedId: null,
		negativeSimilarity: 0,
		quality: 0,
		freshness: 0,
		era: 0,
		typeAffinity: 0,
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

function ids(slate: readonly RecommendationScore[]): string[] {
	return slate.map((item) => item.candidate.id);
}

const MOVIE_ONLY: Record<MetadataType, number> = { movie: 1, tv_show: 0 };

describe("recommendation slate", () => {
	test("prefers a diverse title over a near-duplicate with a higher score", () => {
		const original = entry("A", 0.9, [[keyword("a"), 1]]);
		const nearDuplicate = entry("B", 0.85, [
			[keyword("a"), 0.995],
			[keyword("b"), 0.099875],
		]);
		const diverse = entry("C", 0.8, [[keyword("c"), 1]]);

		const slate = buildRecommendationSlate([original, nearDuplicate, diverse], [], 2, MOVIE_ONLY, { minimumItems: 1 });

		expect(ids(slate)).toEqual(["A", "C"]);
	});

	test("caps a slate at the larger of two and a third of the limit per genre when competing", () => {
		const sharedGenre = { primaryGenreId: "genre-drama", primaryGenreLabel: "Drama" };
		const entries = Array.from({ length: 12 }, (_, index) =>
			entry(`s${index + 1}`, 1 - index * 0.01, [[keyword(`k${index + 1}`), 1]], sharedGenre),
		);

		const large = buildRecommendationSlate(entries, [], 9, MOVIE_ONLY, { minimumItems: 1 });
		const small = buildRecommendationSlate(entries, [], 3, MOVIE_ONLY, { minimumItems: 1 });

		expect(ids(large)).toEqual(["s1", "s2", "s3"]);
		expect(ids(small)).toEqual(["s1", "s2"]);
	});

	test("serves every qualified item when there is no competition", () => {
		const sharedGenre = { primaryGenreId: "genre-drama", primaryGenreLabel: "Drama" };
		const entries = [
			entry("s1", 0.9, [[keyword("k1"), 1]], sharedGenre),
			entry("s2", 0.8, [[keyword("k2"), 1]], sharedGenre),
			entry("s3", 0.7, [[keyword("k3"), 1]], sharedGenre),
			entry("s4", 0.6, [[keyword("k4"), 1]], sharedGenre),
		];

		const slate = buildRecommendationSlate(entries, [], 9, MOVIE_ONLY, { minimumItems: 1 });

		expect(ids(slate)).toEqual(["s1", "s2", "s3", "s4"]);
	});

	test("allows only one title from a collection", () => {
		const sharedCollection = { collectionIds: ["collection-1"] };
		const entries = [
			entry("c1", 0.9, [[keyword("k1"), 1]], sharedCollection),
			entry("c2", 0.8, [[keyword("k2"), 1]], sharedCollection),
			entry("c3", 0.7, [[keyword("k3"), 1]], sharedCollection),
		];

		const slate = buildRecommendationSlate(entries, [], 2, MOVIE_ONLY, { minimumItems: 1 });

		expect(ids(slate)).toEqual(["c1"]);
	});

	test("keeps one title per collection on a short slate with room to spare", () => {
		// A thin profile that matched a whole franchise must not get a row of its sequels.
		const sharedCollection = { collectionIds: ["collection-1"] };
		const entries = [
			entry("c1", 0.9, [[keyword("k1"), 1]], sharedCollection),
			entry("c2", 0.8, [[keyword("k2"), 1]], sharedCollection),
			entry("other", 0.5, [[keyword("k3"), 1]]),
		];

		const slate = buildRecommendationSlate(entries, [], 20, MOVIE_ONLY, { minimumItems: 1 });

		expect(ids(slate)).toEqual(["c1", "other"]);
	});

	test("backfills to the minimum only, never to the requested limit", () => {
		const fallback = [
			entry("f1", 0.5, [[keyword("f1"), 1]]),
			entry("f2", 0.4, [[keyword("f2"), 1]]),
			entry("f3", 0.3, [[keyword("f3"), 1]]),
		];

		const slate = buildRecommendationSlate([], fallback, 9, MOVIE_ONLY, { minimumItems: 2 });

		expect(ids(slate)).toEqual(["f1", "f2"]);
	});
});

describe("recommendation slate type caps and seed buckets", () => {
	test("allows at most one movie for a strongly TV-leaning profile", () => {
		const tvHeavy: Record<MetadataType, number> = { movie: 0.14, tv_show: 0.86 };
		const entries = [
			entry("m1", 0.95, [[keyword("m1"), 1]]),
			entry("m2", 0.94, [[keyword("m2"), 1]]),
			entry("s1", 0.9, [[keyword("s1"), 1]], { candidate: candidate("s1", "tv_show") }),
			entry("s2", 0.8, [[keyword("s2"), 1]], { candidate: candidate("s2", "tv_show") }),
			entry("s3", 0.7, [[keyword("s3"), 1]], { candidate: candidate("s3", "tv_show") }),
		];

		const slate = buildRecommendationSlate(entries, [], 10, tvHeavy, { minimumItems: 1 });

		expect(ids(slate)).toEqual(["m1", "s1", "s2", "s3"]);
	});

	test("fills one leader per seed bucket before a higher-scoring duplicate", () => {
		const buckets = [
			entry("a", 0.9, [[keyword("a"), 1]], { topSeedId: "seed-a" }),
			entry("a2", 0.88, [[keyword("a2"), 1]], { topSeedId: "seed-a" }),
			entry("b", 0.8, [[keyword("b"), 1]], { topSeedId: "seed-b" }),
			entry("c", 0.7, [[keyword("c"), 1]], { topSeedId: "seed-c" }),
		];

		const slate = buildRecommendationSlate(buckets, [], 4, MOVIE_ONLY, {
			minimumItems: 1,
			topSeedIds: ["seed-a", "seed-b", "seed-c"],
		});

		expect(ids(slate)).toEqual(["a", "a2", "b", "c"]);
	});

	test("keeps the genre cap while filling seed buckets", () => {
		const sharedGenre = { primaryGenreId: "genre-drama", primaryGenreLabel: "Drama" };
		const buckets = [
			entry("a", 0.9, [[keyword("a"), 1]], { topSeedId: "seed-a", ...sharedGenre }),
			entry("b", 0.8, [[keyword("b"), 1]], { topSeedId: "seed-b", ...sharedGenre }),
			entry("c", 0.7, [[keyword("c"), 1]], { topSeedId: "seed-c", ...sharedGenre }),
			entry("d", 0.6, [[keyword("d"), 1]], { topSeedId: "seed-d" }),
		];

		const slate = buildRecommendationSlate(buckets, [], 3, MOVIE_ONLY, {
			minimumItems: 1,
			topSeedIds: ["seed-a", "seed-b", "seed-c", "seed-d"],
		});

		expect(ids(slate)).toEqual(["a", "b", "d"]);
	});
});
