import { describe, expect, test } from "bun:test";
import { analyzeMediaFileTask, type MediaFileAnalysisTaskDependencies } from "./media-file-analysis.worker";

describe("media-file-analysis worker", () => {
	test("emits media ready after applying plugin analysis", async () => {
		const calls: string[] = [];
		const dependencies: MediaFileAnalysisTaskDependencies = {
			getPublicMedia: () => Promise.resolve({ id: "media-1", metadataId: "metadata-1", fileName: "movie.mkv", available: true }),
			analyzeMedia: () => Promise.resolve({ qualityTag: "1080p" }),
			updateMediaFile: () => {
				calls.push("update");

				return Promise.resolve();
			},
			emitMediaReady: () => {
				calls.push("ready");

				return Promise.resolve();
			},
		};

		await expect(
			analyzeMediaFileTask({ libraryId: "library-1", mediaFileId: "media-1", metadataId: "metadata-1" }, {}, dependencies),
		).resolves.toEqual({ mediaFileId: "media-1", analyzed: true });
		expect(calls).toEqual(["update", "ready"]);
	});
});
