import { describe, expect, it } from "bun:test";
import { fileScannerService } from "../disk/file-scanner";
import { compareFilePaths, filterPathsWithinRoots, isMassRemoval } from "./scanner.utils";

describe("compareFilePaths", () => {
	it("compares discovered files with media-file rows rather than configured directory paths", () => {
		const result = compareFilePaths(["/movies/existing.mkv", "/movies/new.mkv"], ["/movies/existing.mkv", "/movies/removed.mkv"]);

		expect(result).toEqual({
			newFiles: ["/movies/new.mkv"],
			removedFiles: ["/movies/removed.mkv"],
		});
	});

	it("marks all database files as removed when a library directory becomes empty", () => {
		expect(compareFilePaths([], ["/movies/removed.mkv"]).removedFiles).toEqual(["/movies/removed.mkv"]);
	});
});

describe("filterPathsWithinRoots", () => {
	it("does not remove files from library roots that were not scanned", () => {
		expect(
			filterPathsWithinRoots(
				["/library/movies/one.mkv", "/library/shows/episode.mkv", "/library/movies-extra/other.mkv"],
				["/library/movies"],
			),
		).toEqual(["/library/movies/one.mkv"]);
	});
});

describe("FileScannerService.diff", () => {
	it("keeps database comparison inside the scanner feature", () => {
		expect(
			fileScannerService.diff(
				["/library/movies/new.mkv"],
				["/library/movies/new.mkv", "/library/movies/removed.mkv", "/library/shows/untouched.mkv"],
				["/library/movies"],
			),
		).toEqual({
			newFiles: [],
			removedFiles: ["/library/movies/removed.mkv"],
		});
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

	it("allows normal incremental removals", () => {
		expect(isMassRemoval(500, 12, 495)).toBeFalse();
		expect(isMassRemoval(0, 0, 0)).toBeFalse();
		expect(isMassRemoval(500, 0, 500)).toBeFalse();
	});
});
