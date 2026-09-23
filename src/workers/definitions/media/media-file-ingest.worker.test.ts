import { describe, expect, test } from "bun:test";
import type { LibraryWithRelations } from "@reelvault/sdk/common";
import type { ProcessedMediaFileWithMarkers } from "@/modules/scanner/scanner.types";
import { ingestMediaFileTask, type MediaFileIngestTaskDependencies } from "./media-file-ingest.worker";

function createMockLibrary(overrides: Partial<LibraryWithRelations> = {}): LibraryWithRelations {
	return {
		id: "library-1",
		name: "Movies",
		type: "movies",
		metadataStorageMode: "database",
		sidecarFlavor: "reelvault",
		paths: [],
		mediaFiles: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function createMockProcessedFile(overrides: Partial<ProcessedMediaFileWithMarkers> = {}): ProcessedMediaFileWithMarkers {
	return {
		metadataId: "metadata-1",
		movieId: "movie-1",
		episodeId: null,
		filePath: "/media/movie.mkv",
		fileName: "movie.mkv",
		formatName: "matroska",
		duration: 3600,
		size: 1000,
		sourceMtimeMs: 12345,
		bitRate: 5000,
		source: null,
		edition: null,
		qualityTag: null,
		isEnabled: true,
		isDefault: true,
		videoStreams: [],
		audioStreams: [],
		subtitles: [],
		automaticMarkers: [],
		...overrides,
	};
}

describe("media-file-ingest worker", () => {
	test("persists one ingested file before scheduling its analysis", async () => {
		const calls: string[] = [];
		const dependencies: MediaFileIngestTaskDependencies = {
			findLibrary: () => Promise.resolve(createMockLibrary({ id: "library-1" })),
			processFile: (_type, _filePath, _skipExistingLookup, _signal, scheduling) => {
				calls.push(`process:${scheduling?.dependsOnTaskIds?.join(",")}`);

				return Promise.resolve(createMockProcessedFile({ metadataId: "metadata-1" }));
			},
			upsertScanFinding: () => {
				calls.push("recordFinding");

				return Promise.resolve();
			},
			deleteScanFinding: () => {
				calls.push("clearFinding");

				return Promise.resolve();
			},
			createMediaFile: () => {
				calls.push("persist");

				return Promise.resolve({ mediaFile: { id: "media-1" }, created: true });
			},
			findMediaByPaths: () =>
				Promise.resolve([{ filePath: "/media/movie.mkv", metadataId: "metadata-1", movieId: "movie-1", episodeId: null }]),
			saveSidecars: () => {
				calls.push("sidecars");

				return Promise.resolve();
			},
			emitMediaDiscovered: () => {
				calls.push("discovered");

				return Promise.resolve();
			},
			emitMediaIdentified: () => {
				calls.push("identified");

				return Promise.resolve();
			},
			enqueueAnalysis: (_data, options) => {
				calls.push(`analysis:${options?.dependsOnTaskIds?.join(",")}`);

				return Promise.resolve({ id: "analysis-1" });
			},
			enqueueTrickplayGeneration: (_mediaFileId: string) => {
				calls.push("trickplay");

				return Promise.resolve({ id: "trickplay-1" });
			},
		};

		await expect(
			ingestMediaFileTask({ libraryId: "library-1", libraryType: "movie", filePath: "/media/movie.mkv" }, {}, dependencies, {
				operationId: "operation-1",
				taskId: "ingest-1",
			}),
		).resolves.toMatchObject({ mediaFileId: "media-1", created: true, analysisTaskId: "analysis-1" });

		expect(calls).toEqual([
			"process:ingest-1",
			"clearFinding",
			"persist",
			"trickplay",
			"sidecars",
			"discovered",
			"identified",
			"analysis:ingest-1",
		]);
	});

	test("records a scan finding and skips persistence when processing reports a skip reason", async () => {
		const calls: string[] = [];
		const findings: Array<{ libraryId: string; filePath: string; fileName: string; reason: string }> = [];
		const dependencies: MediaFileIngestTaskDependencies = {
			findLibrary: () => Promise.resolve(createMockLibrary({ id: "library-1" })),
			processFile: () => Promise.resolve({ skipReason: "no_metadata_match", fileName: "movie.mkv" }),
			upsertScanFinding: (finding) => {
				calls.push("recordFinding");
				findings.push(finding);

				return Promise.resolve();
			},
			deleteScanFinding: () => {
				calls.push("clearFinding");

				return Promise.resolve();
			},
			createMediaFile: () => {
				calls.push("persist");

				return Promise.resolve({ mediaFile: { id: "media-1" }, created: true });
			},
			findMediaByPaths: () => Promise.resolve([]),
			saveSidecars: () => Promise.resolve(),
			emitMediaDiscovered: () => Promise.resolve(),
			emitMediaIdentified: () => Promise.resolve(),
			enqueueAnalysis: () => Promise.resolve({ id: "analysis-1" }),
			enqueueTrickplayGeneration: () => Promise.resolve({ id: "trickplay-1" }),
		};

		await expect(
			ingestMediaFileTask({ libraryId: "library-1", libraryType: "movie", filePath: "/media/movie.mkv" }, {}, dependencies),
		).resolves.toEqual({
			libraryId: "library-1",
			filePath: "/media/movie.mkv",
			mediaFileId: null,
			created: false,
			skipReason: "no_metadata_match",
		});

		expect(calls).toEqual(["recordFinding"]);
		expect(findings[0]).toEqual({
			libraryId: "library-1",
			filePath: "/media/movie.mkv",
			fileName: "movie.mkv",
			reason: "no_metadata_match",
		});
	});

	test("completes missing post-create side effects when retrying an existing file", async () => {
		const calls: string[] = [];
		const dependencies: MediaFileIngestTaskDependencies = {
			findLibrary: () => Promise.resolve(createMockLibrary({ id: "library-1" })),
			processFile: () => Promise.resolve(createMockProcessedFile({ metadataId: "metadata-1" })),
			upsertScanFinding: () => Promise.resolve(),
			deleteScanFinding: () => {
				calls.push("clearFinding");

				return Promise.resolve();
			},
			createMediaFile: () => Promise.resolve({ mediaFile: { id: "media-1" }, created: false }),
			findMediaByPaths: () => Promise.resolve([]),
			saveSidecars: () => {
				calls.push("sidecars");

				return Promise.resolve();
			},
			emitMediaDiscovered: () => {
				calls.push("discovered");

				return Promise.resolve();
			},
			emitMediaIdentified: () => Promise.resolve(),
			readIngestProgress: () => Promise.resolve({ sidecarWritten: false, discoveredEmitted: false }),
			markSidecarWritten: () => {
				calls.push("markSidecar");

				return Promise.resolve();
			},
			markDiscoveredEmitted: () => {
				calls.push("markDiscovered");

				return Promise.resolve();
			},
			enqueueAnalysis: () => Promise.resolve({ id: "analysis-1" }),
			enqueueTrickplayGeneration: () => Promise.resolve({ id: "trickplay-1" }),
		};

		await expect(
			ingestMediaFileTask({ libraryId: "library-1", libraryType: "movie", filePath: "/media/movie.mkv" }, {}, dependencies, {
				operationId: "operation-1",
				taskId: "ingest-1",
				attempt: 2,
			}),
		).resolves.toMatchObject({ mediaFileId: "media-1", created: false, analysisTaskId: "analysis-1" });

		expect(calls).toEqual(["clearFinding", "sidecars", "markSidecar", "discovered", "markDiscovered"]);
	});
});
