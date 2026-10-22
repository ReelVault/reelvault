import { describe, expect, it } from "bun:test";
import { filterPathsWithinRoots, isMassRemoval } from "./scanner.utils";

describe("filterPathsWithinRoots", () => {
	it("keeps only paths inside the scanned roots and rejects a sibling folder that shares the name prefix", () => {
		expect(
			filterPathsWithinRoots(
				["/library/movies/one.mkv", "/library/shows/episode.mkv", "/library/movies-extra/other.mkv"],
				["/library/movies"],
			),
		).toEqual(["/library/movies/one.mkv"]);
	});
});

describe("isMassRemoval", () => {
	it("flags an empty scan over a non-empty library", () => {
		expect(isMassRemoval(500, 500, 0)).toBeTrue();
		expect(isMassRemoval(500, 120, 0)).toBeTrue();
	});

	it("flags removals covering at least half of the library", () => {
		expect(isMassRemoval(500, 250, 300)).toBeTrue();
		expect(isMassRemoval(10, 5, 6)).toBeTrue();
	});

	it("allows a small incremental removal and flags neither an empty library nor an empty candidate list", () => {
		expect(isMassRemoval(500, 12, 495)).toBeFalse();
		expect(isMassRemoval(0, 0, 0)).toBeFalse();
		expect(isMassRemoval(500, 0, 500)).toBeFalse();
	});
});
