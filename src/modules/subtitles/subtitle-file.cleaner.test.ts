import { describe, expect, test } from "bun:test";
import { SubtitleFileCleaner } from "./subtitle-file.cleaner";

function createCleaner({ subtitlesPath = "/data/subtitles" }: { subtitlesPath?: string } = {}) {
	const deletedPaths: string[] = [];
	const cleaner = new SubtitleFileCleaner({
		deleteFile: (path) => {
			deletedPaths.push(path);

			return Promise.resolve(true);
		},
		subtitlesPath: () => subtitlesPath,
	});

	return { cleaner, deletedPaths };
}

describe("SubtitleFileCleaner", () => {
	test("deletes the extracted VTT cache file for the subtitle", async () => {
		const { cleaner, deletedPaths } = createCleaner();

		await cleaner.deleteArtifacts("sub-1", { type: "embedded", filePath: null });

		expect(deletedPaths).toEqual(["/data/subtitles/sub-1.vtt"]);
	});

	test("deletes an external source file kept under the subtitles root", async () => {
		const { cleaner, deletedPaths } = createCleaner();

		await cleaner.deleteArtifacts("sub-2", { type: "external", filePath: "/data/subtitles/movie.en.srt" });

		expect(deletedPaths).toEqual(["/data/subtitles/sub-2.vtt", "/data/subtitles/movie.en.srt"]);
	});

	test("keeps an external file stored outside the subtitles root", async () => {
		const { cleaner, deletedPaths } = createCleaner();

		await cleaner.deleteArtifacts("sub-3", { type: "external", filePath: "/media/library/movie.en.srt" });

		expect(deletedPaths).toEqual(["/data/subtitles/sub-3.vtt"]);
	});

	test("never deletes the media file itself for an embedded subtitle", async () => {
		const { cleaner, deletedPaths } = createCleaner();

		await cleaner.deleteArtifacts("sub-4", { type: "embedded", filePath: "/media/library/movie.mkv" });

		expect(deletedPaths).toEqual(["/data/subtitles/sub-4.vtt"]);
	});

	test("deletes only the VTT cache when an external subtitle has no source path", async () => {
		const { cleaner, deletedPaths } = createCleaner();

		await cleaner.deleteArtifacts("sub-5", { type: "external", filePath: null });

		expect(deletedPaths).toEqual(["/data/subtitles/sub-5.vtt"]);
	});
});
