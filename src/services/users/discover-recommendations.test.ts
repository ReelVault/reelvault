import { describe, expect, test } from "bun:test";
import { DAY } from "@/config/server/server.constants";
import { metadataRepository } from "@/repositories/metadata.repository";
import { toMap } from "@/utils/array.utils";
import { insertMetadata } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import {
	applyDiversityFilter,
	buildRelationScores,
	buildTrending,
	coldStartFallback,
	recencyMultiplier,
	scoreCandidate,
} from "./discover-recommendations.service";

const db = useTestDatabase();

describe("recencyMultiplier", () => {
	test("a timestamp from a minute ago keeps almost full weight", () => {
		expect(recencyMultiplier(Date.now() - 60_000)).toBeCloseTo(1.0, 2);
	});

	test("a timestamp 130 days old keeps half weight", () => {
		expect(recencyMultiplier(Date.now() - 130 * DAY)).toBeCloseTo(0.5, 2);
	});

	test("timestamp 0 (no engagement) is clamped to the 0.2 floor", () => {
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

		const withGenre = scoreCandidate({ genreIds: ["genre-action"], keywordIds: [], castIds: [] }, 5, {
			genre: genreScores,
			keyword: empty,
			cast: empty,
		});
		const withoutGenre = scoreCandidate({ genreIds: [], keywordIds: [], castIds: [] }, 5, {
			genre: genreScores,
			keyword: empty,
			cast: empty,
		});

		// The genre match scores 10 × 1.0; both items add the popularity term 5 × 0.03.
		expect(withGenre).toBeCloseTo(10.15, 5);
		expect(withoutGenre).toBeCloseTo(0.15, 5);
	});

	test("popularity-only score equals popularity × POPULARITY_WEIGHT", () => {
		const empty = new Map<string, number>();
		const result = scoreCandidate({ genreIds: [], keywordIds: [], castIds: [] }, 100, { genre: empty, keyword: empty, cast: empty });
		expect(result).toBeCloseTo(100 * 0.03, 5);
	});

	test("weights a genre match above a cast match and a cast match above a keyword match", () => {
		const scores = new Map([["x", 10]]);
		const empty = new Map<string, number>();

		const genreOnly = scoreCandidate({ genreIds: ["x"], keywordIds: [], castIds: [] }, 0, { genre: scores, keyword: empty, cast: empty });
		const castOnly = scoreCandidate({ genreIds: [], keywordIds: [], castIds: ["x"] }, 0, { genre: empty, keyword: empty, cast: scores });
		const kwOnly = scoreCandidate({ genreIds: [], keywordIds: ["x"], castIds: [] }, 0, { genre: empty, keyword: scores, cast: empty });

		// A relation score of 10 is weighted 1.0 for a genre, 0.7 for a cast member and 0.5 for a keyword.
		expect(genreOnly).toBeCloseTo(10, 5);
		expect(castOnly).toBeCloseTo(7, 5);
		expect(kwOnly).toBeCloseTo(5, 5);
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
	// Ten genre-A items rank first, then one genre-B item. The genre-A cap is max(2, floor(limit / 3)).
	// Because genre-B is not capped, it lands right after the first `cap` genre-A items.
	test.each([
		[3, 2],
		[6, 2],
		[9, 3],
		[10, 3],
	])("at limit %i a genre takes at most %i slots before another genre gets one", (limit, cap) => {
		const items = Array.from({ length: 11 }, (_, i) => ({ id: i < 10 ? `a${i + 1}` : "b1" }));
		const genres = new Map<string, string | undefined>(items.map((item) => [item.id, item.id === "b1" ? "genre-B" : "genre-A"]));

		const result = applyDiversityFilter(items, genres, limit).map((item) => item.id);

		expect(result).toHaveLength(limit);
		expect(result.indexOf("b1")).toBe(cap);
	});

	test("fills remaining slots when diversity filter leaves gaps", () => {
		// All items share the same genre — filter should still return `limit` items
		const items = Array.from({ length: 10 }, (_, i) => ({ id: `item-${i}` }));
		const primaryGenreOf = new Map(items.map((i) => [i.id, "genre-A"] as [string, string]));
		const result = applyDiversityFilter(items, primaryGenreOf, 10);
		expect(result.length).toBe(10);
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

	test("returns every candidate when the pool is smaller than the limit", () => {
		const candidates = [
			{ id: "a", popularity: 10, createdAt: new Date() },
			{ id: "b", popularity: 5, createdAt: new Date() },
		];
		const result = coldStartFallback(candidates, 10);
		expect(result.map((r) => r.id)).toEqual(["a", "b"]);
	});
});

// ---------------------------------------------------------------------------
// buildTrending
// ---------------------------------------------------------------------------

describe("buildTrending", () => {
	test("breaks an equal play count by popularity", async () => {
		await insertMetadata(db.client(), [
			{ id: "aaa-niche", stableKey: "aaa-niche", title: "aaa-niche", type: "movie", releaseDate: "2020-01-01", popularity: 40 },
			{ id: "zzz-fan", stableKey: "zzz-fan", title: "zzz-fan", type: "movie", releaseDate: "2020-01-01", popularity: 90 },
		]);
		// Popularity is normalised by the largest value in knownMap, so the items are loaded before the call.
		const known = toMap(await metadataRepository.findManyByIdsWithRelations(["aaa-niche", "zzz-fan"]), (item) => item.id);

		// The niche title comes first in the activity rows, so only the popularity term can move the fan title ahead.
		const trending = await buildTrending(
			[
				{ metadataId: "aaa-niche", playCount: 1 },
				{ metadataId: "zzz-fan", playCount: 1 },
			],
			[],
			10,
			known,
		);

		expect(trending.map((item) => item.id)).toEqual(["zzz-fan", "aaa-niche"]);
	});
});
