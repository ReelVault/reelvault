import { describe, expect, test } from "bun:test";
import {
	checkLibraryErrorsTask,
	createLibraryErrorsCheckDedupeKey,
	type LibraryErrorsCheckTaskDependencies,
} from "./library-errors-check.worker";

describe("library error check task", () => {
	test("checks every discovered MKV and returns FFmpeg errors with file paths", async () => {
		const checked: string[] = [];
		const dependencies: LibraryErrorsCheckTaskDependencies = {
			findMkvFiles: (libraryPaths) => {
				expect(libraryPaths).toEqual(["/media/movies"]);

				return Promise.resolve(["/media/movies/clean.mkv", "/media/movies/broken.MkV"]);
			},
			checkFile: (filePath) => {
				checked.push(filePath);

				return Promise.resolve(filePath.endsWith("broken.MkV") ? "[matroska] damaged frame" : "");
			},
		};

		await expect(checkLibraryErrorsTask({ libraryPaths: ["/media/movies", "/media/movies"] }, {}, dependencies)).resolves.toEqual({
			libraryPaths: ["/media/movies"],
			scannedFiles: 2,
			cleanFiles: 1,
			problematicFiles: [{ filePath: "/media/movies/broken.MkV", errors: "[matroska] damaged frame" }],
		});
		expect(checked).toEqual(["/media/movies/clean.mkv", "/media/movies/broken.MkV"]);
	});

	test("uses the same dedupe key for equivalent path order", () => {
		expect(createLibraryErrorsCheckDedupeKey(["/media/tv", "/media/movies"])).toBe(
			createLibraryErrorsCheckDedupeKey(["/media/movies", "/media/tv"]),
		);
	});
});
