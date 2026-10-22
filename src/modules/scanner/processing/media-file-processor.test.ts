import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sleep } from "bun";
import type { FFProbeResult } from "@/integrations/ffprobe/ffprobe.types";
import { recognitionService } from "@/modules/recognition/recognition.service";
import { videoParser } from "@/modules/scanner/probe/video-parser.service";
import { getFileStats as actualGetFileStats } from "@/utils/file.utils";
import { insertMovieMediaFile } from "../../../../tests/helpers/media.fixture";
import { type MethodStub, stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { mockModuleWithRealExports, restoreModuleMocks } from "../../../../tests/helpers/module-mock.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { createMediaFileProcessor, type MetadataCheckInput, type MetadataMatch, type MetadataMatcher } from "./media-file.processor";

// The mock replaces the module, so the real implementation is captured before
// it lands: a mock that called back into the module it replaces would recurse.
const realGetFileStats = actualGetFileStats;

let getFileStatsImpl: (path: string) => Promise<unknown> = realGetFileStats;
mockModuleWithRealExports("@/utils/file.utils", {
	getFileStats: (path: string) => getFileStatsImpl(path),
});

// Recognition parses the real file names and the duplicate check reads the test database.
// Stubbed: ffprobe (external process), file stats (the paths are not on disk) and metadata
// resolution, which reaches the processor through its matcher.
const db = useTestDatabase();
const stubs: MethodStub[] = [];
let checkMetadataCalls: MetadataCheckInput[] = [];
let resolveMetadata: (input: MetadataCheckInput) => Promise<MetadataMatch | undefined> = () => Promise.resolve(undefined);

const validProbe: FFProbeResult = { streams: [], format: { duration: "90.000" } };

const metadataMatcher: MetadataMatcher = {
	checkMetadata(input) {
		checkMetadataCalls.push(input);

		return resolveMetadata(input);
	},
};

function stubMetadata(resolve: (episode: number | undefined) => MetadataMatch | undefined): void {
	resolveMetadata = (input) => Promise.resolve(resolve((input.parsed as { episode?: number }).episode));
}

function stubPhysicalFile(): void {
	getFileStatsImpl = () => Promise.resolve({ size: 12_345, mtimeMs: 1234.7 });
	stubs.push(stubMethod(videoParser, "probe", () => Promise.resolve(validProbe)));
}

beforeEach(() => {
	checkMetadataCalls = [];
	stubMetadata(() => ({ metadataId: "meta-1", movieId: "mov-1", episodeId: null }));
});

afterEach(() => {
	getFileStatsImpl = realGetFileStats;
	// Reverse order: a method stubbed twice must unwind to its original implementation.
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

// The next test file must get the real module back.
afterAll(() => {
	restoreModuleMocks();
});

const mediaFileProcessor = createMediaFileProcessor(metadataMatcher);

describe("mediaFileProcessor.process skip outcomes", () => {
	test("rejects an empty filePath", async () => {
		await expect(mediaFileProcessor.process("movie", "")).rejects.toMatchObject({
			category: "validation",
			code: "media_file.path_required",
		});
	});

	test("propagates an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(mediaFileProcessor.process("movie", "/media/movie.mkv", true, { signal: controller.signal })).rejects.toMatchObject({
			name: "CancellationError",
		});
	});

	test("returns null when the file is already registered and leaves it untouched", async () => {
		await insertMovieMediaFile(db.client(), "/media/Movie (2020)/movie.mkv");

		await expect(mediaFileProcessor.process("movie", "/media/Movie (2020)/movie.mkv")).resolves.toBeNull();
		expect(checkMetadataCalls).toEqual([]);
	});

	test("reports recognition_failed when no recognizer claims the file", async () => {
		stubs.push(stubMethod(recognitionService, "recognize", () => null));

		await expect(mediaFileProcessor.process("movie", "/media/movie.mkv")).resolves.toEqual({
			skipReason: "recognition_failed",
			fileName: "movie.mkv",
		});
	});

	test("reports type_mismatch when a recognized movie is filed under a TV library", async () => {
		await expect(mediaFileProcessor.process("tv_show", "/media/Movie (2020)/movie.mkv")).resolves.toEqual({
			skipReason: "type_mismatch",
			fileName: "movie.mkv",
		});
	});

	test("reports no_metadata_match when metadata resolution yields no id", async () => {
		stubPhysicalFile();
		stubMetadata(() => undefined);

		await expect(mediaFileProcessor.process("movie", "/media/Movie (2020)/movie.mkv")).resolves.toEqual({
			skipReason: "no_metadata_match",
			fileName: "movie.mkv",
		});
	});

	test("reports probe_failed when the probe yields no technical data", async () => {
		getFileStatsImpl = () => Promise.resolve({ size: 12_345, mtimeMs: 1234.7 });
		stubs.push(stubMethod(videoParser, "probe", () => Promise.resolve(null)));

		await expect(mediaFileProcessor.process("movie", "/media/Movie (2020)/movie.mkv")).resolves.toEqual({
			skipReason: "probe_failed",
			fileName: "movie.mkv",
		});
	});
});

describe("mediaFileProcessor.process processed movies", () => {
	test("maps a recognized movie with probe data, file stats and chapter markers", async () => {
		stubPhysicalFile();
		stubs.push(
			stubMethod(videoParser, "probe", () =>
				Promise.resolve({
					streams: [],
					format: { duration: "90.000" },
					chapters: [{ start_time: "00:00:00.000", end_time: "00:01:30.000", tags: { title: "Intro" } }],
				}),
			),
		);

		const result = await mediaFileProcessor.process("movie", "/media/Movie (2020)/movie.mkv");

		expect(result).toMatchObject({
			metadataId: "meta-1",
			movieId: "mov-1",
			episodeId: null,
			filePath: "/media/Movie (2020)/movie.mkv",
			fileName: "movie.mkv",
			isEnabled: true,
			size: 12_345,
			sourceMtimeMs: 1234,
		});
		const markers = result && !("skipReason" in result) ? result.automaticMarkers : undefined;
		expect(markers?.[0]).toMatchObject({ type: "intro", startSeconds: 0, endSeconds: 90, label: "Intro" });
		expect(checkMetadataCalls[0]).toMatchObject({ type: "movie", parsed: { title: "Movie", year: 2020 } });
	});

	test("concurrent calls for the same file share one processing run", async () => {
		stubPhysicalFile();
		let releaseProbe: ((value: FFProbeResult | null) => void) | undefined;
		stubs.push(
			stubMethod(videoParser, "probe", () => {
				if (releaseProbe) return Promise.resolve(null);

				return new Promise<FFProbeResult | null>((resolve) => {
					releaseProbe = resolve;
				});
			}),
		);

		const first = mediaFileProcessor.process("movie", "/media/Movie (2020)/movie.mkv");
		// Yield once so the first run reaches the probe and holds the in-flight slot.
		await sleep(0);
		const second = mediaFileProcessor.process("movie", "/media/Movie (2020)/movie.mkv");
		releaseProbe?.(null);

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult).toBe(secondResult);
		expect(checkMetadataCalls).toHaveLength(1);
	});
});

describe("mediaFileProcessor.process multi-episode files", () => {
	test("resolves one metadata target per episode in a range file", async () => {
		stubPhysicalFile();
		stubMetadata((episode) => ({ metadataId: "meta-1", movieId: null, episodeId: `ep-${episode}` }));

		const result = await mediaFileProcessor.process("tv_show", "/media/Show/Season 1/Show.S01E01-E03.mkv");
		const processed = result && !("skipReason" in result) ? result : undefined;

		expect(processed?.episodeId).toBe("ep-1");
		expect(processed?.additionalTargets).toEqual([
			{ metadataId: "meta-1", movieId: null, episodeId: "ep-2" },
			{ metadataId: "meta-1", movieId: null, episodeId: "ep-3" },
		]);
		expect(checkMetadataCalls.map((call) => (call.parsed as { episode: number }).episode)).toEqual([1, 2, 3]);
	});

	test("a failing episode does not stop the other episodes of the file", async () => {
		stubPhysicalFile();
		resolveMetadata = (input) => {
			const episode = (input.parsed as { episode: number }).episode;
			if (episode === 2) return Promise.reject(new Error("provider timeout"));

			return Promise.resolve({ metadataId: "meta-1", movieId: null, episodeId: `ep-${episode}` });
		};

		const result = await mediaFileProcessor.process("tv_show", "/media/Show/Season 1/Show.S01E01-E03.mkv");
		const processed = result && !("skipReason" in result) ? result : undefined;

		expect(processed?.episodeId).toBe("ep-1");
		expect(processed?.additionalTargets).toEqual([{ metadataId: "meta-1", movieId: null, episodeId: "ep-3" }]);
	});

	test("treats an absurd range as a single episode", async () => {
		stubPhysicalFile();
		stubMetadata((episode) => ({ metadataId: "meta-1", movieId: null, episodeId: `ep-${episode}` }));

		const result = await mediaFileProcessor.process("tv_show", "/media/Show/Season 1/Show.S01E01-E99.mkv");
		const processed = result && !("skipReason" in result) ? result : undefined;

		expect(processed?.additionalTargets).toBeUndefined();
		expect(checkMetadataCalls).toHaveLength(1);
	});
});
