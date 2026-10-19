import { describe, expect, test } from "bun:test";
import { parseEpisode } from "./catalog-episode.parser";

describe("parseEpisode", () => {
	test("parses SxxExx season and episode numbers case-insensitively", () => {
		expect(parseEpisode("Show S01E02.mkv")).toEqual({ season: 1, number: 2 });
		expect(parseEpisode("show.s12e100.720p.mkv")).toEqual({ season: 12, number: 100 });
	});

	test("parses the same alternate episode names online recognition accepts", () => {
		expect(parseEpisode("Show 1x05.mkv")).toEqual({ season: 1, number: 5 });
		expect(parseEpisode("Show S01E01-E03.mkv")).toEqual({ season: 1, number: 1 });
		expect(parseEpisode("One.Piece.S01E1000.mkv")).toEqual({ season: 1, number: 1000 });
	});

	test("returns undefined when the file name carries no episode marker", () => {
		expect(parseEpisode("movie.nfo")).toBeUndefined();
		expect(parseEpisode("Season 1")).toBeUndefined();
		expect(parseEpisode("Show E100.mkv")).toBeUndefined();
	});
});
