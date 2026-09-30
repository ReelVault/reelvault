import { describe, expect, test } from "bun:test";
import type { MediaIdentity } from "@reelvault/sdk/common";
import { extractSeasonEpisode, parseFileName, resolveShowTitle } from "./recognition.utils";

function identity(title: string, year?: number): MediaIdentity {
	return { title, type: "movie", year };
}

describe("parseFileName", () => {
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
