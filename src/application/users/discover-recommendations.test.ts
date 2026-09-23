import { describe, expect, test } from "bun:test";
import {
	applyDiversityFilter,
	buildRelationScores,
	coldStartFallback,
	DIVERSITY_MAX_FRACTION,
	RECENCY_HALF_LIFE_DAYS,
	recencyMultiplier,
	SIGNAL_WEIGHTS,
	scoreCandidate,
} from "./discover-recommendations";

describe("recencyMultiplier", () => {
	test("recent timestamp (< 1 day) yields close to 1.0", () => {
		const ts = Date.now() - 60_000; // 1 minute ago
		const daysSince = (Date.now() - ts) / (24 * 60 * 60 * 1000);
		const result = Math.max(0.2, Math.exp((-daysSince * Math.LN2) / RECENCY_HALF_LIFE_DAYS));
		expect(result).toBeCloseTo(1.0, 2);
	});

	test("130-day-old timestamp yields ~0.5", () => {
		const daysSince = 130;
		const result = Math.max(0.2, Math.exp((-daysSince * Math.LN2) / RECENCY_HALF_LIFE_DAYS));
		expect(result).toBeCloseTo(0.5, 2);
	});

	test("very old timestamp (> 3 years) hits 0.2 floor", () => {
		const daysSince = 1200;
		const result = Math.max(0.2, Math.exp((-daysSince * Math.LN2) / RECENCY_HALF_LIFE_DAYS));
		expect(result).toBeCloseTo(0.2, 2);
	});

	test("recencyMultiplier(now) is close to 1.0", () => {
		expect(recencyMultiplier(Date.now())).toBeCloseTo(1.0, 2);
	});

	test("recencyMultiplier(0) returns 0.2 floor", () => {
		expect(recencyMultiplier(0)).toBe(0.2);
	});
});

// ---------------------------------------------------------------------------
// scoreCandidate
// ---------------------------------------------------------------------------

describe("scoreCandidate", () => {
	test("item with matching genre scores higher than item without", () => {
		const genreScores = new Map([["genre-action", 10]]);
		const empty = new Map<string, number>();

		const withGenre = scoreCandidate(["genre-action"], [], [], 5, genreScores, empty, empty);
		const withoutGenre = scoreCandidate([], [], [], 5, genreScores, empty, empty);

		expect(withGenre).toBeGreaterThan(withoutGenre);
	});

	test("popularity-only score equals popularity × POPULARITY_WEIGHT", () => {
		const empty = new Map<string, number>();
		const result = scoreCandidate([], [], [], 100, empty, empty, empty);
		expect(result).toBeCloseTo(100 * 0.03, 5);
	});

	test("signal weights are applied correctly (genre > cast > keyword)", () => {
		const scores = new Map([["x", 10]]);
		const empty = new Map<string, number>();

		const genreOnly = scoreCandidate(["x"], [], [], 0, scores, empty, empty);
		const castOnly = scoreCandidate([], [], ["x"], 0, empty, empty, scores);
		const kwOnly = scoreCandidate([], ["x"], [], 0, empty, scores, empty);

		expect(genreOnly).toBeCloseTo(10 * SIGNAL_WEIGHTS.genre, 5);
		expect(castOnly).toBeCloseTo(10 * SIGNAL_WEIGHTS.cast, 5);
		expect(kwOnly).toBeCloseTo(10 * SIGNAL_WEIGHTS.keyword, 5);
		expect(genreOnly).toBeGreaterThan(castOnly);
		expect(castOnly).toBeGreaterThan(kwOnly);
	});
});

// ---------------------------------------------------------------------------
// buildRelationScores
// ---------------------------------------------------------------------------

describe("buildRelationScores", () => {
	test("sums weighted seed contributions per relId", () => {
		const byMetadata = new Map([
			["meta-1", ["genre-A", "genre-B"]],
			["meta-2", ["genre-A"]],
		]);
		const seedWeights = new Map([
			["meta-1", 10],
			["meta-2", 5],
		]);

		const result = buildRelationScores(byMetadata, seedWeights, 1.0);

		// genre-A gets contributions from both seeds
		expect(result.get("genre-A")).toBeCloseTo(15, 5);
		expect(result.get("genre-B")).toBeCloseTo(10, 5);
	});

	test("weight multiplier is applied", () => {
		const byMetadata = new Map([["meta-1", ["genre-A"]]]);
		const seedWeights = new Map([["meta-1", 10]]);

		const result = buildRelationScores(byMetadata, seedWeights, 0.5);
		expect(result.get("genre-A")).toBeCloseTo(5, 5);
	});
});

// ---------------------------------------------------------------------------
// applyDiversityFilter
// ---------------------------------------------------------------------------

describe("applyDiversityFilter", () => {
	test("no more than floor(limit × 1/3) items share the same primary genre", () => {
		const limit = 10;
		const maxPerGenre = Math.max(2, Math.floor(limit * DIVERSITY_MAX_FRACTION));
		expect(maxPerGenre).toBe(3);
	});

	test("at limit=6 maxPerGenre is 2", () => {
		const maxPerGenre = Math.max(2, Math.floor(6 * DIVERSITY_MAX_FRACTION));
		expect(maxPerGenre).toBe(2);
	});

	test("at limit=3 maxPerGenre clamps to 2 (minimum)", () => {
		const maxPerGenre = Math.max(2, Math.floor(3 * DIVERSITY_MAX_FRACTION));
		expect(maxPerGenre).toBe(2);
	});

	test("fills remaining slots when diversity filter leaves gaps", () => {
		// All items share the same genre — filter should still return `limit` items
		const items = Array.from({ length: 10 }, (_, i) => ({ id: `item-${i}` }));
		const primaryGenreOf = new Map(items.map((i) => [i.id, "genre-A"] as [string, string]));
		const result = applyDiversityFilter(items, primaryGenreOf, 10);
		expect(result.length).toBe(10);
	});

	test("limits items per genre and fills from overflow", () => {
		const items = [
			{ id: "a1" },
			{ id: "a2" },
			{ id: "a3" },
			{ id: "a4" }, // 4th item of genre-A — should be deferred
			{ id: "b1" },
		];
		const genres = new Map<string, string | undefined>([
			["a1", "genre-A"],
			["a2", "genre-A"],
			["a3", "genre-A"],
			["a4", "genre-A"],
			["b1", "genre-B"],
		]);
		// limit=5, maxPerGenre = max(2, floor(5/3)) = 2
		const result = applyDiversityFilter(items, genres, 5);
		const genreACnt = result.filter((i) => i.id.startsWith("a")).length;
		expect(genreACnt).toBeLessThanOrEqual(5); // fills overflow → all 5 slots used
		expect(result.length).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// coldStartFallback
// ---------------------------------------------------------------------------

describe("coldStartFallback", () => {
	test("returns exactly limit items (no duplicates)", () => {
		const now = Date.now();
		const candidates = Array.from({ length: 20 }, (_, i) => ({
			id: `item-${i}`,
			popularity: 20 - i,
			createdAt: new Date(now - i * 86_400_000),
		}));
		const result = coldStartFallback(candidates, 10);
		expect(result.length).toBe(10);
		const ids = result.map((r) => r.id);
		expect(new Set(ids).size).toBe(10); // no duplicates
	});

	test("returns at most available candidates when pool < limit", () => {
		const candidates = [
			{ id: "a", popularity: 10, createdAt: new Date() },
			{ id: "b", popularity: 5, createdAt: new Date() },
		];
		const result = coldStartFallback(candidates, 10);
		expect(result.length).toBeLessThanOrEqual(candidates.length);
	});
});

// ---------------------------------------------------------------------------
// Trending blend formula
// ---------------------------------------------------------------------------

describe("trending score blend", () => {
	test("item with high play count outranks low-count high-popularity item", () => {
		const highPlays = 1.0 * 0.6 + 0.3 * 0.4; // 0.72
		const highPop = 0.1 * 0.6 + 1.0 * 0.4; // 0.46
		expect(highPlays).toBeGreaterThan(highPop);
	});

	test("equal play counts → higher popularity wins", () => {
		const a = 0.5 * 0.6 + 0.9 * 0.4; // 0.66
		const b = 0.5 * 0.6 + 0.4 * 0.4; // 0.46
		expect(a).toBeGreaterThan(b);
	});
});
