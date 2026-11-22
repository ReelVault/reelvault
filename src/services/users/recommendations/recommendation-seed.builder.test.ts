import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { buildRecommendationSeeds, type RecommendationSeedInput } from "./recommendation-seed.builder";

const NOW = 1_767_225_600_000;
const DAY_MS = 86_400_000;

beforeEach(() => {
	setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});

afterEach(() => {
	setSystemTime();
});

function seed(overrides: Partial<RecommendationSeedInput> = {}): RecommendationSeedInput {
	return {
		metadataId: "title",
		type: "movie",
		status: null,
		releaseDate: "2000-01-01",
		watchedEpisodes: 0,
		totalEpisodes: null,
		watchCount: 0,
		lastWatchedAt: null,
		completionRatio: 0,
		isFullWatch: false,
		rating: null,
		watchlistAddedAt: null,
		...overrides,
	};
}

describe("recommendation seeds", () => {
	test("weights a 20-of-20 binge watched now at full strength", () => {
		const input = seed({
			type: "tv_show",
			watchedEpisodes: 20,
			totalEpisodes: 20,
			watchCount: 1,
			lastWatchedAt: NOW,
			completionRatio: 1,
			isFullWatch: true,
		});

		const result = buildRecommendationSeeds([input], NOW);

		expect(result.positive).toHaveLength(1);
		expect(result.positive[0]?.metadataId).toBe("title");
		expect(result.positive[0]?.type).toBe("tv_show");
		expect(result.positive[0]?.weight).toBeCloseTo(1, 10);
		expect(result.positive[0]?.watchlistOnly).toBeFalse();
	});

	test("weights a 5-of-10 show at 0.65", () => {
		const input = seed({
			type: "tv_show",
			watchedEpisodes: 5,
			totalEpisodes: 10,
			watchCount: 1,
			lastWatchedAt: NOW,
			completionRatio: 0.5,
		});

		const result = buildRecommendationSeeds([input], NOW);

		expect(result.positive).toHaveLength(1);
		expect(result.positive[0]?.weight).toBeCloseTo(0.65, 10);
	});

	test("keeps a 1-of-20 drop as a weak positive a hundred days later", () => {
		const input = seed({
			type: "tv_show",
			watchedEpisodes: 1,
			totalEpisodes: 20,
			watchCount: 1,
			lastWatchedAt: NOW - 100 * DAY_MS,
			completionRatio: 0.05,
		});

		const result = buildRecommendationSeeds([input], NOW);

		expect(result.positive).toHaveLength(1);
		expect(result.positive[0]?.weight).toBeCloseTo(0.1225168493, 8);
		expect(result.negative).toEqual([]);
	});

	test("turns an explicit zero rating into a dislike and no positive seed", () => {
		const input = seed({
			rating: 0,
			watchedEpisodes: 1,
			totalEpisodes: 10,
			watchCount: 1,
			lastWatchedAt: NOW,
			completionRatio: 0.1,
		});

		const result = buildRecommendationSeeds([input], NOW);

		expect(result.positive).toEqual([]);
		expect(result.negative).toEqual([{ metadataId: "title", type: "movie", weight: 1, watchlistOnly: false }]);
	});

	test("files an unwatched saved title under watchlist, never positive", () => {
		const input = seed({ watchlistAddedAt: new Date(NOW) });

		const result = buildRecommendationSeeds([input], NOW);

		expect(result.positive).toEqual([]);
		expect(result.watchlist).toHaveLength(1);
		expect(result.watchlist[0]?.type).toBe("movie");
		expect(result.watchlist[0]?.weight).toBeCloseTo(0.15, 10);
		expect(result.watchlist[0]?.watchlistOnly).toBeTrue();
	});

	test("counts a watched title once even when it is also on the watchlist", () => {
		const input = seed({
			watchlistAddedAt: new Date(NOW),
			watchedEpisodes: 10,
			totalEpisodes: 10,
			watchCount: 1,
			lastWatchedAt: NOW,
			completionRatio: 1,
			isFullWatch: true,
		});

		const result = buildRecommendationSeeds([input], NOW);

		expect(result.watchlist).toEqual([]);
		expect(result.positive).toHaveLength(1);
		expect(result.positive[0]?.weight).toBeCloseTo(1, 10);
	});
});

describe("recommendation seed aggregates", () => {
	test("derives type share from watched seeds alone", () => {
		const movie = seed({
			metadataId: "movie",
			watchedEpisodes: 10,
			totalEpisodes: 10,
			watchCount: 1,
			lastWatchedAt: NOW,
			completionRatio: 1,
			isFullWatch: true,
		});
		const show = seed({
			metadataId: "show",
			type: "tv_show",
			watchedEpisodes: 5,
			totalEpisodes: 10,
			watchCount: 1,
			lastWatchedAt: NOW,
			completionRatio: 0.5,
		});
		const savedMovie = seed({ metadataId: "saved-movie", watchlistAddedAt: new Date(NOW) });

		const result = buildRecommendationSeeds([movie, show, savedMovie], NOW);

		expect(result.typeShare.movie).toBeCloseTo(0.6060606061, 8);
		expect(result.typeShare.tv_show).toBeCloseTo(0.3939393939, 8);
	});

	test("weights the preferred release year by each seed's strength", () => {
		const older = seed({
			metadataId: "older",
			releaseDate: "2000-01-01",
			watchedEpisodes: 10,
			totalEpisodes: 10,
			watchCount: 1,
			lastWatchedAt: NOW,
			completionRatio: 1,
			isFullWatch: true,
		});
		const newer = seed({
			metadataId: "newer",
			releaseDate: "2010-01-01",
			type: "tv_show",
			watchedEpisodes: 5,
			totalEpisodes: 10,
			watchCount: 1,
			lastWatchedAt: NOW,
			completionRatio: 0.5,
		});

		const result = buildRecommendationSeeds([older, newer], NOW);

		expect(result.preferredYear).toBeCloseTo(2003.9393939394, 8);
	});
});
