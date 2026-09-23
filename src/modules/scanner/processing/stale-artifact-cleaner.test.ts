import { beforeEach, describe, expect, test } from "bun:test";
import { StaleArtifactCleaner } from "./stale-artifact-cleaner";

interface Harness {
	cleaner: StaleArtifactCleaner;
	deletedPaths: string[];
	artifactRemovals: string[][];
	statsCleared: boolean;
	unavailableEvents: Array<{ libraryId: string; mediaFileId: string }>;
}

function createHarness(): Harness {
	const harness: Harness = {
		cleaner: undefined as never,
		deletedPaths: [],
		artifactRemovals: [],
		statsCleared: false,
		unavailableEvents: [],
	};
	harness.cleaner = new StaleArtifactCleaner({
		deleteByLibraryAndPaths: () =>
			Promise.resolve({
				artifactStorageKeys: ["artifact-key-1"],
				subtitleFilePaths: ["/data/subtitles/kept.vtt", "/elsewhere/outside.vtt", null],
				subtitleIds: ["sub-1"],
				removedMediaFiles: [
					{ id: "media-1", filePath: "/media/gone.mkv" },
					{ id: "media-2", filePath: "/media/gone-too.mkv" },
				],
			}),
		removeArtifactStorageFiles: (keys) => {
			harness.artifactRemovals.push(keys);

			return Promise.resolve();
		},
		deleteFile: (path) => {
			harness.deletedPaths.push(path);

			return Promise.resolve(true);
		},
		getIoConcurrency: () => 4,
		subtitlesPath: () => "/data/subtitles",
		clearLibraryStatsCache: () => {
			harness.statsCleared = true;
		},
		emitMediaUnavailable: (input) => {
			harness.unavailableEvents.push({ libraryId: input.libraryId, mediaFileId: input.mediaFileId });

			return Promise.resolve();
		},
	});

	return harness;
}

describe("StaleArtifactCleaner", () => {
	let harness: Harness;

	beforeEach(() => {
		harness = createHarness();
	});

	test("removes artifact storage, in-root subtitle files and clears library stats", async () => {
		await harness.cleaner.cleanup("lib-1", ["/media/gone.mkv"]);

		expect(harness.artifactRemovals).toEqual([["artifact-key-1"]]);
		expect(harness.deletedPaths).toEqual(["/data/subtitles/kept.vtt", "/data/subtitles/sub-1.vtt"]);
		expect(harness.statsCleared).toBeTrue();
	});

	test("never deletes subtitle files from outside the subtitles root", async () => {
		await harness.cleaner.cleanup("lib-1", ["/media/gone.mkv"]);

		expect(harness.deletedPaths).not.toContain("/elsewhere/outside.vtt");
	});

	test("emits media.file.unavailable for every removed media file", async () => {
		await harness.cleaner.cleanup("lib-1", ["/media/gone.mkv", "/media/gone-too.mkv"]);

		expect(harness.unavailableEvents).toEqual([
			{ libraryId: "lib-1", mediaFileId: "media-1" },
			{ libraryId: "lib-1", mediaFileId: "media-2" },
		]);
	});
});
