import { describe, expect, test } from "bun:test";
import {
	keywordGenreConcentration,
	type RecommendationFeatureRow,
	type RecommendationFeatureStats,
	recommendationFeatureKey,
	recommendationFeatureSpecificity,
} from "@/utils/recommendation-feature.utils";
import { buildRecommendationItemVector } from "./recommendation-vector.builder";

const CATALOG_SIZE = 100;

function feature(kind: RecommendationFeatureRow["kind"], id: string): RecommendationFeatureRow {
	return { metadataId: "title", kind, id, label: id };
}

function catalogStats(documentFrequency: ReadonlyMap<string, number>): RecommendationFeatureStats {
	return { totalTitles: CATALOG_SIZE, documentFrequency, globalMeanRating: 8 };
}

describe("recommendation item vector", () => {
	test("weights a rare keyword far above a common genre", () => {
		const drama = recommendationFeatureKey("genre", "drama");
		const cyberpunk = recommendationFeatureKey("keyword", "cyberpunk");
		const stats = catalogStats(
			new Map([
				[drama, 80],
				[cyberpunk, 2],
			]),
		);

		const vector = buildRecommendationItemVector("title", [feature("genre", "drama"), feature("keyword", "cyberpunk")], stats);

		expect(vector.weights.get(drama)).toBeCloseTo(0.0849598033, 8);
		expect(vector.weights.get(cyberpunk)).toBeCloseTo(0.9963843796, 8);
	});

	test("normalizes a two-feature vector to unit L2 norm", () => {
		const alpha = recommendationFeatureKey("keyword", "alpha");
		const beta = recommendationFeatureKey("keyword", "beta");
		const stats = catalogStats(
			new Map([
				[alpha, 1],
				[beta, 4],
			]),
		);

		const vector = buildRecommendationItemVector("title", [feature("keyword", "alpha"), feature("keyword", "beta")], stats);

		expect(vector.norm).toBe(1);
		expect(vector.weights.get(alpha)).toBeCloseTo(0.7906722692, 8);
		expect(vector.weights.get(beta)).toBeCloseTo(0.6122396285, 8);
	});

	test("keeps at most 24 keywords from a keyword-stuffed record", () => {
		const rows: RecommendationFeatureRow[] = [];
		const documentFrequency = new Map<string, number>();
		for (let index = 0; index < 30; index += 1) {
			const id = `kw-${index}`;
			rows.push(feature("keyword", id));
			documentFrequency.set(recommendationFeatureKey("keyword", id), 1);
		}

		const vector = buildRecommendationItemVector("title", rows, catalogStats(documentFrequency));
		let keywords = 0;
		for (const item of vector.features.values()) {
			if (item.kind === "keyword") keywords += 1;
		}

		expect(keywords).toBe(24);
	});

	test("scores a catalog-wide keyword far below the theme threshold", () => {
		const common = recommendationFeatureKey("keyword", "drama");
		const stats = catalogStats(new Map([[common, 50]]));

		const vector = buildRecommendationItemVector("title", [feature("keyword", "drama")], stats);

		expect(vector.features.get(common)?.specificity).toBeCloseTo(0.2351952024, 8);
	});
});

describe("crew credits in an item vector", () => {
	function credit(id: string, role: string): RecommendationFeatureRow {
		return { metadataId: "title", kind: "credit", id, label: id, role };
	}

	/** A provider that names jobs in Polish: the census weighs them like any other names. */
	function creditStats(documentFrequency: ReadonlyMap<string, number>): RecommendationFeatureStats {
		return {
			...catalogStats(documentFrequency),
			roleWeights: new Map([
				["Reżyseria", 1],
				["Muzyka", 0.5],
			]),
		};
	}

	test("weights a credit by its job's catalog weight", () => {
		const director = recommendationFeatureKey("credit", "director");
		const composer = recommendationFeatureKey("credit", "composer");
		const stats = creditStats(
			new Map([
				[director, 2],
				[composer, 2],
			]),
		);

		const vector = buildRecommendationItemVector("title", [credit("director", "Reżyseria"), credit("composer", "Muzyka")], stats);

		// Same IDF, role weights 1 and 0.5: the normalized weights are 2/√5 and 1/√5.
		expect(vector.weights.get(director)).toBeCloseTo(0.894427191, 8);
		expect(vector.weights.get(composer)).toBeCloseTo(0.4472135955, 8);
	});

	test("leaves out a credit whose job the census dropped", () => {
		const stunt = recommendationFeatureKey("credit", "stunt");
		const theme = recommendationFeatureKey("keyword", "theme");
		const stats = creditStats(
			new Map([
				[stunt, 2],
				[theme, 2],
			]),
		);

		const vector = buildRecommendationItemVector("title", [credit("stunt", "Kaskader"), feature("keyword", "theme")], stats);

		expect([...vector.features.keys()]).toEqual([theme]);
	});

	test("keeps the strongest job of a person credited twice on one title", () => {
		const person = recommendationFeatureKey("credit", "person");
		const stats = creditStats(new Map([[person, 2]]));

		const vector = buildRecommendationItemVector("title", [credit("person", "Muzyka"), credit("person", "Reżyseria")], stats);

		expect(vector.features.get(person)).toMatchObject({ role: "Reżyseria", roleWeight: 1 });
	});

	test("keeps at most six credits from a crew-heavy record", () => {
		const rows: RecommendationFeatureRow[] = [];
		const documentFrequency = new Map<string, number>();
		for (let index = 0; index < 9; index += 1) {
			const id = `person-${index}`;
			rows.push(credit(id, "Reżyseria"));
			documentFrequency.set(recommendationFeatureKey("credit", id), 1);
		}

		const vector = buildRecommendationItemVector("title", rows, creditStats(documentFrequency));

		expect(vector.features.size).toBe(6);
	});
});

describe("keyword genre concentration", () => {
	test("rates a keyword used in a single genre at full concentration", () => {
		expect(keywordGenreConcentration(new Map([["drama", 10]]))).toBe(1);
	});

	test("rates a keyword spread evenly over four genres at zero", () => {
		const counts = new Map([
			["a", 5],
			["b", 5],
			["c", 5],
			["d", 5],
		]);

		expect(keywordGenreConcentration(counts)).toBe(0);
	});

	test("rates a keyword mostly in one genre above a coin flip", () => {
		const counts = new Map([
			["drama", 9],
			["comedy", 1],
		]);

		expect(keywordGenreConcentration(counts)).toBeCloseTo(0.5310044064, 8);
	});

	test("leaves a single-genre keyword's specificity and weight unchanged", () => {
		const drama = recommendationFeatureKey("genre", "drama");
		const cyberpunk = recommendationFeatureKey("keyword", "cyberpunk");
		const stats = catalogStats(
			new Map([
				[drama, 80],
				[cyberpunk, 2],
			]),
		);

		const vector = buildRecommendationItemVector("title", [feature("genre", "drama"), feature("keyword", "cyberpunk")], {
			...stats,
			keywordConcentration: new Map([[cyberpunk, 1]]),
		});

		expect(vector.features.get(cyberpunk)?.concentration).toBe(1);
		expect(vector.features.get(cyberpunk)?.specificity).toBeCloseTo(0.7662024614, 8);
		expect(vector.weights.get(cyberpunk)).toBeCloseTo(0.9963843796, 8);
	});

	test("scales a spread keyword's weight to 55 percent but leaves specificity unchanged", () => {
		const drama = recommendationFeatureKey("genre", "drama");
		const cyberpunk = recommendationFeatureKey("keyword", "cyberpunk");
		const stats = catalogStats(
			new Map([
				[drama, 80],
				[cyberpunk, 2],
			]),
		);
		const withConcentration = (concentration: number) =>
			buildRecommendationItemVector("title", [feature("genre", "drama"), feature("keyword", "cyberpunk")], {
				...stats,
				keywordConcentration: new Map([[cyberpunk, concentration]]),
			});
		const concentrated = withConcentration(1);
		const spread = withConcentration(0);
		const concentratedRatio = (concentrated.weights.get(cyberpunk) ?? 0) / (concentrated.weights.get(drama) ?? 1);
		const spreadRatio = (spread.weights.get(cyberpunk) ?? 0) / (spread.weights.get(drama) ?? 1);

		expect(spread.features.get(cyberpunk)?.concentration).toBe(0);
		expect(spread.features.get(cyberpunk)?.specificity).toBeCloseTo(0.7662024614, 8);
		expect(spreadRatio / concentratedRatio).toBeCloseTo(0.55, 10);
	});
});

describe("recommendation feature specificity", () => {
	test("rates a one-off feature at full specificity and a ubiquitous one at near zero", () => {
		const uniqueIdf = Math.log(1 + 1000);
		const ubiquitousIdf = Math.log(1 + 1000 / 1_000_001);

		expect(recommendationFeatureSpecificity(uniqueIdf, 1000)).toBe(1);
		expect(recommendationFeatureSpecificity(ubiquitousIdf, 1000)).toBeCloseTo(0.0001446714156, 10);
	});
});
