import { describe, expect, test } from "bun:test";
import type { MediaIdentity } from "@reelvault/sdk/common";
import {
	episodeRangeSpan,
	episodeRangeTargets,
	extractPathProviderIds,
	extractSeasonEpisode,
	parseFileName,
	resolveEpisodeNumbers,
	resolveShowTitle,
} from "./recognition.utils";

describe("extractPathProviderIds", () => {
	test("takes the nearest valid id of each provider, so the file name beats its folders", () => {
		expect(extractPathProviderIds(["Movie [tmdbid-1]", "Movie (1993) [tmdbid-329].mkv"])).toEqual({ tmdb: "329" });
	});

	test("reads braced and parenthesised tags, keeps IMDb ids lower-case and ignores invalid TMDB ids", () => {
		expect(extractPathProviderIds(["Film {imdb-TT0107290} (tmdbid=abc)"])).toEqual({ imdb: "tt0107290" });
	});

	test("returns nothing when the path carries no provider tag", () => {
		expect(extractPathProviderIds(["Movies", "Jurassic Park (1993).mkv"])).toEqual({});
	});
});

function identity(title: string, year?: number): MediaIdentity {
	return { title, type: "movie", year };
}

describe("parseFileName", () => {
	describe("movie names with a year", () => {
		const cases: Array<[string, string, number | undefined]> = [
			["Jurassic.Park.1993.Remastered.2160p.mkv", "Jurassic Park", 1993],
			["Blade Runner 2049 (2017).mkv", "Blade Runner 2049", 2017],
			["2001 A Space Odyssey (1968).mkv", "2001 A Space Odyssey", 1968],
			["1917 (2019).mkv", "1917", 2019],
			["1917.2019.1080p.mkv", "1917", 2019],
			["Movie 2012 2017 1080p BluRay.mkv", "Movie 2012", 2017],
			["Jurassic Park (1993) [tmdbid-329].mkv", "Jurassic Park", 1993],
			["Jurassic Park (1993) {tmdb-329}.mkv", "Jurassic Park", 1993],
		];
		test.each(cases)("%s", (fileName, title, year) => {
			expect(parseFileName(fileName)).toEqual({ title, type: "movie", year });
		});
	});

	describe("year-first movie names", () => {
		test.each([
			["1993 - Jurassic Park.mkv", "Jurassic Park", 1993],
			["(1993) Jurassic Park.mkv", "Jurassic Park", 1993],
			["(2019) 1917.mkv", "1917", 2019],
		])("%s", (fileName, title, year) => {
			expect(parseFileName(fileName)).toEqual({ title, type: "movie", year });
		});

		test("a leading year that is part of the title is not taken as the release year", () => {
			expect(parseFileName("2001 A Space Odyssey 1968.mkv")).toEqual({ title: "2001 A Space Odyssey", type: "movie", year: 1968 });
			expect(parseFileName("2001 - A Space Odyssey (1968).mkv")).toEqual({ title: "2001 - A Space Odyssey", type: "movie", year: 1968 });
		});
	});

	test("strips provider id tags even when the name has no year", () => {
		expect(parseFileName("Jurassic Park [imdbid-tt0107290].mkv")).toEqual({ title: "Jurassic Park", type: "movie", year: undefined });
	});

	test("provider id tags do not leak into episode titles", () => {
		expect(parseFileName("Breaking Bad (2008) [tvdbid-81189] - S01E02.mkv")).toMatchObject({
			title: "Breaking Bad",
			season: 1,
			episode: 2,
			year: 2008,
		});
	});

	test('parses "Name (YYYY) - S01E01 - Title" with a dash separator', () => {
		expect(parseFileName("Game of Thrones (2011) - S01E01 - Winter Is Coming.mkv")).toEqual({
			title: "Game of Thrones",
			type: "episode",
			season: 1,
			episode: 1,
			year: 2011,
		});
	});

	test("dash separator without episode title", () => {
		expect(parseFileName("Breaking Bad (2008) - S01E02.mp4")).toMatchObject({
			title: "Breaking Bad",
			season: 1,
			episode: 2,
			year: 2008,
		});
	});

	test("keeps a hyphen that belongs to the show title", () => {
		expect(parseFileName("The X-Files S01E01.mkv")).toMatchObject({
			title: "The X-Files",
			season: 1,
			episode: 1,
			year: undefined,
		});
	});

	test("still parses dot-separated year and season markers", () => {
		expect(parseFileName("Show.2011.S01E01.mkv")).toMatchObject({
			title: "Show",
			season: 1,
			episode: 1,
			year: 2011,
		});
	});

	test("parses a three-digit season spelling (S012E03)", () => {
		expect(parseFileName("Example.Show.S012E03.mkv")).toMatchObject({
			title: "Example Show",
			type: "episode",
			season: 12,
			episode: 3,
		});
	});
});

describe("multi-episode ranges and copy suffixes", () => {
	test("parses an SxxExx-Eyy range", () => {
		expect(parseFileName("Show.S01E01-E02.mkv")).toMatchObject({ title: "Show", season: 1, episode: 1, episodeEnd: 2 });
	});

	test("parses a bare range in a season folder", () => {
		expect(extractSeasonEpisode("Show - 01-02.mkv")).toEqual({ episode: 1, episodeEnd: 2 });
	});

	test("does not read 1080p as a range end", () => {
		expect(parseFileName("Show.S01E01-1080p.mkv")).toEqual({ title: "Show", type: "episode", season: 1, episode: 1, year: undefined });
	});

	test("drops a descending range", () => {
		expect(parseFileName("Show.S01E05-E02.mkv")).toEqual({ title: "Show", type: "episode", season: 1, episode: 5, year: undefined });
	});

	test("ignores a _001 copy suffix as an episode marker", () => {
		expect(extractSeasonEpisode("My.Movie.2020_001.mkv")).toEqual({});
		expect(parseFileName("My Movie (2010)_001.mkv")).toEqual(identity("My Movie", 2010));
	});

	test("keeps bare dot and space episode markers working", () => {
		expect(extractSeasonEpisode("Show - 01.mkv")).toEqual({ episode: 1 });
		expect(extractSeasonEpisode("Show.E02.mkv")).toEqual({ episode: 2 });
	});
});

describe("episode marker delegation edge cases", () => {
	test("keeps the anchored marker when a resolution precedes it", () => {
		expect(parseFileName("Show.1920x1080.S01E02.mkv")).toEqual({
			title: "Show 1920x1080",
			type: "episode",
			season: 1,
			episode: 2,
			year: undefined,
		});
	});

	test("does not read a marker without a separator as a series file", () => {
		expect(parseFileName("xS01E01.mkv")).toEqual({ title: "xS01E01", type: "movie", year: undefined });
	});

	test("reads a three-digit episode number in full", () => {
		expect(parseFileName("Show.S1E100.mkv")).toMatchObject({ season: 1, episode: 100 });
	});

	test("reads a three-digit episode range in full", () => {
		expect(parseFileName("Show.S1E100-E102.mkv")).toMatchObject({ season: 1, episode: 100, episodeEnd: 102 });
	});

	test("reads a four-digit episode number in full", () => {
		expect(parseFileName("Show.S1E1000.mkv")).toMatchObject({ season: 1, episode: 1000 });
	});

	test("reads a bare four-digit episode after an E prefix or a dash (One Piece)", () => {
		expect(extractSeasonEpisode("One.Piece.E1000.mkv")).toEqual({ episode: 1000 });
		expect(extractSeasonEpisode("One Piece - 1000 - Title.mkv")).toEqual({ episode: 1000 });
	});

	test("does not read a bare year as an episode", () => {
		expect(extractSeasonEpisode("Blade.Runner.2049.mkv")).toEqual({});
	});

	test("refuses a five-digit episode number instead of truncating it", () => {
		expect(parseFileName("Show.S1E10000.mkv")).not.toHaveProperty("episode");
		expect(extractSeasonEpisode("Show.S1E10000.mkv")).toEqual({});
	});

	test("prefers the marker over an earlier bare number", () => {
		expect(parseFileName("Show - 01 - S01E02.mkv")).toMatchObject({ title: "Show - 01", season: 1, episode: 2 });
	});

	test("reads a dotted range after a 1x01 marker", () => {
		expect(parseFileName("Show.1x01.2x03.mkv")).toMatchObject({ season: 1, episode: 1, episodeEnd: 2 });
	});

	test("keeps a copy suffix out of the episode branch", () => {
		expect(parseFileName("Show_001.mkv")).toEqual({ title: "Show 001", type: "movie", year: undefined });
	});
});

describe("resolveEpisodeNumbers", () => {
	test("prefers the parsed identity over the extractor", () => {
		const parsed: MediaIdentity = { title: "Show", type: "episode", season: 2, episode: 5 };

		expect(resolveEpisodeNumbers("Show - 01.mkv", parsed)).toEqual({ season: 2, episode: 5, episodeEnd: undefined });
	});

	test("falls back to the filename extractor for a bare episode number", () => {
		const parsed: MediaIdentity = { title: "Show - 05", type: "movie", year: undefined };

		expect(resolveEpisodeNumbers("Show - 05.mkv", parsed)).toEqual({ season: undefined, episode: 5, episodeEnd: undefined });
	});

	test("uses the folder season for a bare episode number", () => {
		expect(resolveEpisodeNumbers("Show - 05.mkv", null, 3)).toEqual({ season: 3, episode: 5, episodeEnd: undefined });
	});

	test("keeps the identity season over the folder season", () => {
		const parsed: MediaIdentity = { title: "Show", type: "episode", season: 2, episode: 5 };

		expect(resolveEpisodeNumbers("Show.S02E05.mkv", parsed, 3)).toEqual({ season: 2, episode: 5, episodeEnd: undefined });
	});

	test("returns an unresolved result for a file without episode markers", () => {
		expect(resolveEpisodeNumbers("Movie.2008.mkv", null)).toEqual({
			season: undefined,
			episode: undefined,
			episodeEnd: undefined,
		});
	});
});

describe("episodeRangeSpan and episodeRangeTargets", () => {
	test("returns no range for a plain episode", () => {
		const single: MediaIdentity = { title: "Show", type: "episode", season: 1, episode: 3 };

		expect(episodeRangeSpan(single)).toBeUndefined();
		expect(episodeRangeTargets(single)).toBeUndefined();
	});

	test("expands a supported range into every covered episode", () => {
		const range: MediaIdentity = { title: "Show", type: "episode", season: 1, episode: 3, episodeEnd: 5 };

		expect(episodeRangeSpan(range)).toBe(3);
		expect(episodeRangeTargets(range)).toEqual([3, 4, 5]);
	});

	test("treats an over-long range as scene noise", () => {
		const overLong: MediaIdentity = { title: "Show", type: "episode", season: 1, episode: 1, episodeEnd: 99 };

		expect(episodeRangeSpan(overLong)).toBeUndefined();
		expect(episodeRangeTargets(overLong)).toBeUndefined();
	});

	test("ignores movies, descending ranges and missing episode numbers", () => {
		const movie: MediaIdentity = { title: "Movie", type: "movie" };
		const descending: MediaIdentity = { title: "Show", type: "episode", season: 1, episode: 5, episodeEnd: 2 };
		const noEpisode: MediaIdentity = { title: "Show", type: "episode", season: 1 };

		expect(episodeRangeSpan(movie)).toBeUndefined();
		expect(episodeRangeSpan(descending)).toBeUndefined();
		expect(episodeRangeSpan(noEpisode)).toBeUndefined();
		expect(episodeRangeTargets(null)).toBeUndefined();
	});
});

test("parses series filename directly starting with S02E01", () => {
	const identity = parseFileName("S02E01.mkv");

	expect(identity).toEqual({
		title: "S02E01",
		type: "episode",
		season: 2,
		episode: 1,
	});
});

test("parses series filename with episode title after S02E01", () => {
	const identity = parseFileName("S02E01 - Pilot Episode.mkv");

	expect(identity?.type).toBe("episode");
	expect(identity?.season).toBe(2);
	expect(identity?.episode).toBe(1);
});

test("recognizes TV show with year range in filename", () => {
	const identity = parseFileName("Czterej.Pancerni.I.Pies.1966-1970.S00E04.x264.mkv");

	expect(identity).not.toBeNull();
	expect(identity?.title).toBe("Czterej Pancerni I Pies");
	expect(identity?.year).toBe(1966);
	expect(identity?.season).toBe(0);
	expect(identity?.episode).toBe(4);
});

test("strips scene noise on fallback movie when no year is in filename", () => {
	const identity = parseFileName("Iron.Man.MULTI.1080p.BluRay.x265.DDP7.1-DENDA.mkv");

	expect(identity).not.toBeNull();
	expect(identity?.type).toBe("movie");
	expect(identity?.title).toBe("Iron Man");
});

test("parses a year in parentheses before the episode marker without leaking it into the title", () => {
	const identity = parseFileName("Breaking Bad (2008) S01E01.mkv");

	expect(identity).not.toBeNull();
	expect(identity?.type).toBe("episode");
	expect(identity?.title).toBe("Breaking Bad");
	expect(identity?.year).toBe(2008);
	expect(identity?.season).toBe(1);
	expect(identity?.episode).toBe(1);
});

describe("resolveShowTitle", () => {
	test("keeps the show folder title and its year", () => {
		expect(resolveShowTitle(identity("Friends", 1994), null)).toEqual({ title: "Friends", year: 1994 });
	});

	test("falls back to the file year when the show folder has none", () => {
		expect(resolveShowTitle(identity("Friends"), identity("Friends S01E01", 1994)).year).toBe(1994);
	});

	test("adopting the file title rescues a show folder named only by its year", () => {
		const result = resolveShowTitle(identity("2012"), identity("Elementary", 2012));
		expect(result.title).toBe("Elementary");
		expect(result.year).toBe(2012);
	});

	test("keeps the year-named show title when the file title is also just a year", () => {
		expect(resolveShowTitle(identity("2012"), identity("2013", 2012)).title).toBe("2012");
	});

	test("prefers the longer file title when it extends the show title", () => {
		expect(resolveShowTitle(identity("the office"), identity("The Office US")).title).toBe("The Office US");
	});

	test("keeps the show title when the file title is longer but unrelated", () => {
		expect(resolveShowTitle(identity("Friends"), identity("Some Other Show"))).toEqual({
			title: "Friends",
			year: undefined,
		});
	});
});
