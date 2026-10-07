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
		metadataLanguage: null,
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

interface MultiEpisodeHarness {
	calls: string[];
	discovered: Array<{ mediaFileId: string; correlationId: string | undefined }>;
	identified: Array<{ mediaFileId: string; metadataId: string; correlationId: string | undefined }>;
	dependencies: MediaFileIngestTaskDependencies;
}

function createMultiEpisodeHarness(failMetadataId?: string): MultiEpisodeHarness {
	const calls: string[] = [];
	const discovered: MultiEpisodeHarness["discovered"] = [];
	const identified: MultiEpisodeHarness["identified"] = [];
	const dependencies: MediaFileIngestTaskDependencies = {
		findLibrary: () => Promise.resolve(createMockLibrary({ id: "library-1" })),
		processFile: () =>
			Promise.resolve(
				createMockProcessedFile({
					metadataId: "metadata-1",
					movieId: null,
					episodeId: "episode-1",
					additionalTargets: [
						{ metadataId: "metadata-2", movieId: null, episodeId: "episode-2" },
						{ metadataId: "metadata-3", movieId: null, episodeId: "episode-3" },
					],
				}),
			),
		upsertScanFinding: () => Promise.resolve(),
		deleteScanFinding: () => {
			calls.push("clearFinding");

			return Promise.resolve();
		},
		createMediaFile: (data) => {
			calls.push(`persist:${data.metadataId}`);
			if (data.metadataId === failMetadataId) return Promise.reject(new Error("episode row failed"));

			return Promise.resolve({ mediaFile: { id: `media-${data.metadataId}` }, created: true });
		},
		importSidecarSubtitles: (mediaFileId) => {
			calls.push(`subtitles:${mediaFileId}`);

			return Promise.resolve(0);
		},
		findMediaByPaths: () => Promise.resolve([]),
		saveSidecars: (_library, mediaFiles) => {
			calls.push(`sidecars:${mediaFiles[0]?.metadataId}`);

			return Promise.resolve();
		},
		emitMediaDiscovered: (payload) => {
			calls.push(`discovered:${payload.mediaFileId}`);
			discovered.push({ mediaFileId: payload.mediaFileId, correlationId: payload.correlationId });

			return Promise.resolve();
		},
		emitMediaIdentified: (payload) => {
			calls.push(`identified:${payload.mediaFileId}`);
			identified.push({ mediaFileId: payload.mediaFileId, metadataId: payload.metadataId, correlationId: payload.correlationId });

			return Promise.resolve();
		},
		enqueueAnalysis: (data) => {
			calls.push(`analysis:${data.mediaFileId}`);

			return Promise.resolve({ id: `analysis-${data.mediaFileId}` });
		},
		enqueueTrickplayGeneration: (mediaFileId) => {
			calls.push(`trickplay:${mediaFileId}`);

			return Promise.resolve({ id: `trickplay-${mediaFileId}` });
		},
	};

	return { calls, discovered, identified, dependencies };
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

	test("runs the completion sequence per additional episode target in order", async () => {
		const { calls, discovered, identified, dependencies } = createMultiEpisodeHarness();

		await expect(
			ingestMediaFileTask({ libraryId: "library-1", libraryType: "tv_show", filePath: "/media/show.mkv" }, {}, dependencies),
		).resolves.toMatchObject({ mediaFileId: "media-metadata-1", created: true, analysisTaskId: "analysis-media-metadata-1" });

		expect(calls).toEqual([
			"clearFinding",
			"persist:metadata-1",
			"persist:metadata-2",
			"subtitles:media-metadata-2",
			"trickplay:media-metadata-2",
			"analysis:media-metadata-2",
			"sidecars:metadata-2",
			"discovered:media-metadata-2",
			"identified:media-metadata-2",
			"persist:metadata-3",
			"subtitles:media-metadata-3",
			"trickplay:media-metadata-3",
			"analysis:media-metadata-3",
			"sidecars:metadata-3",
			"discovered:media-metadata-3",
			"identified:media-metadata-3",
			"subtitles:media-metadata-1",
			"trickplay:media-metadata-1",
			"sidecars:metadata-1",
			"discovered:media-metadata-1",
			"identified:media-metadata-1",
			"analysis:media-metadata-1",
		]);

		// No correlation id in context — every emission falls back to its own row id.
		expect(discovered.map((event) => [event.mediaFileId, event.correlationId])).toEqual([
			["media-metadata-2", "media-metadata-2"],
			["media-metadata-3", "media-metadata-3"],
			["media-metadata-1", "media-metadata-1"],
		]);
		expect(identified.map((event) => [event.mediaFileId, event.metadataId, event.correlationId])).toEqual([
			["media-metadata-2", "metadata-2", "media-metadata-2"],
			["media-metadata-3", "metadata-3", "media-metadata-3"],
			["media-metadata-1", "metadata-1", "media-metadata-1"],
		]);
	});

	test("isolates a failed additional episode target and still completes the main row", async () => {
		const { calls, dependencies } = createMultiEpisodeHarness("metadata-3");

		await expect(
			ingestMediaFileTask({ libraryId: "library-1", libraryType: "tv_show", filePath: "/media/show.mkv" }, {}, dependencies),
		).resolves.toMatchObject({ mediaFileId: "media-metadata-1", created: true, analysisTaskId: "analysis-media-metadata-1" });

		expect(calls).toEqual([
			"clearFinding",
			"persist:metadata-1",
			"persist:metadata-2",
			"subtitles:media-metadata-2",
			"trickplay:media-metadata-2",
			"analysis:media-metadata-2",
			"sidecars:metadata-2",
			"discovered:media-metadata-2",
			"identified:media-metadata-2",
			"persist:metadata-3",
			"subtitles:media-metadata-1",
			"trickplay:media-metadata-1",
			"sidecars:metadata-1",
			"discovered:media-metadata-1",
			"identified:media-metadata-1",
			"analysis:media-metadata-1",
		]);
	});

	test("repairs post-create side effects for an existing additional target on retry", async () => {
		const calls: string[] = [];
		const dependencies: MediaFileIngestTaskDependencies = {
			findLibrary: () => Promise.resolve(createMockLibrary({ id: "library-1" })),
			processFile: () =>
				Promise.resolve(
					createMockProcessedFile({
						metadataId: "metadata-1",
						movieId: null,
						episodeId: "episode-1",
						additionalTargets: [{ metadataId: "metadata-2", movieId: null, episodeId: "episode-2" }],
					}),
				),
			upsertScanFinding: () => Promise.resolve(),
			deleteScanFinding: () => Promise.resolve(),
			createMediaFile: (data) => {
				calls.push(`persist:${data.metadataId}`);

				// Both rows already exist — a crashed attempt created them.
				return Promise.resolve({ mediaFile: { id: `media-${data.metadataId}` }, created: false });
			},
			findMediaByPaths: () => Promise.resolve([]),
			saveSidecars: (_library, mediaFiles) => {
				calls.push(`sidecars:${mediaFiles[0]?.metadataId}`);

				return Promise.resolve();
			},
			emitMediaDiscovered: (payload) => {
				calls.push(`discovered:${payload.mediaFileId}`);

				return Promise.resolve();
			},
			emitMediaIdentified: (payload) => {
				calls.push(`identified:${payload.mediaFileId}`);

				return Promise.resolve();
			},
			readIngestProgress: (mediaFileId) => {
				calls.push(`progress:${mediaFileId}`);

				// Production returns this shape for a row that never got marked.
				return Promise.resolve({ sidecarWritten: false, discoveredEmitted: false });
			},
			markSidecarWritten: (mediaFileId) => {
				calls.push(`markSidecar:${mediaFileId}`);

				return Promise.resolve();
			},
			markDiscoveredEmitted: (mediaFileId) => {
				calls.push(`markDiscovered:${mediaFileId}`);

				return Promise.resolve();
			},
			enqueueAnalysis: (data) => {
				calls.push(`analysis:${data.mediaFileId}`);

				return Promise.resolve({ id: `analysis-${data.mediaFileId}` });
			},
			enqueueTrickplayGeneration: () => Promise.resolve({ id: "trickplay-1" }),
		};

		await ingestMediaFileTask({ libraryId: "library-1", libraryType: "tv_show", filePath: "/media/show.mkv" }, {}, dependencies, {
			attempt: 2,
		});

		expect(calls).toEqual([
			"persist:metadata-1",
			"persist:metadata-2",
			// The additional target is repaired before the main row completes.
			"progress:media-metadata-2",
			"sidecars:metadata-2",
			"markSidecar:media-metadata-2",
			"discovered:media-metadata-2",
			"markDiscovered:media-metadata-2",
			"analysis:media-metadata-2",
			"progress:media-metadata-1",
			"sidecars:metadata-1",
			"markSidecar:media-metadata-1",
			"discovered:media-metadata-1",
			"markDiscovered:media-metadata-1",
			"analysis:media-metadata-1",
		]);
	});
});
