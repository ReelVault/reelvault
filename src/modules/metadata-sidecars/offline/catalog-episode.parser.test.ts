import { describe, expect, test } from "bun:test";
import { parseEpisode } from "./catalog-episode.parser";

describe("parseEpisode", () => {
	test("parses SxxExx season and episode numbers case-insensitively", () => {
		expect(parseEpisode("Show S01E02.mkv")).toEqual({ season: 1, number: 2 });
		expect(parseEpisode("show.s12e100.720p.mkv")).toEqual({ season: 12, number: 100 });
	});

	test("returns undefined when the file name carries no episode marker", () => {
		expect(parseEpisode("movie.nfo")).toBeUndefined();
		expect(parseEpisode("Season 1")).toBeUndefined();
	});
});
