import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sleep } from "bun";
import { pluginsService } from "@/application/plugins.service";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import type { FFProbeResult } from "@/integrations/ffprobe/ffprobe.types";
import { recognitionService } from "@/modules/recognition/recognition.service";
import { FileUtils } from "@/utils/file.utils";
import { videoParser } from "../probe/video-parser.service";
import { mediaFileProcessor } from "./media-file-processor";

function stubMethod<TArgs extends unknown[] = unknown[]>(
	target: object,
	method: string,
	impl: (...args: TArgs) => unknown,
): { calls: TArgs[]; restore(): void } {
	const original = Reflect.get(target, method);
	const calls: TArgs[] = [];
	const replacement = (...args: TArgs) => {
		calls.push(args);

		return impl(...args);
	};
	Reflect.set(target, method, replacement);

	return {
		calls,
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

const activeStubs: Array<{ restore(): void }> = [];
let checkMetadataCalls: Array<Record<string, unknown>> = [];

beforeEach(() => {
	activeStubs.length = 0;
	checkMetadataCalls = [];
	// The lazy getter builds a real MetadataProcess (import cycle — AGENTS.md);
	// seeding the cache field keeps the fake in place for the whole test.
	Reflect.set(mediaFileProcessor, "metadataProcessInstance", {
		checkMetadata: (input: Record<string, unknown>) => {
			checkMetadataCalls.push(input);

			return Promise.resolve({ metadataId: "meta-1", movieId: "mov-1", episodeId: null });
		},
	});
});

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();

	Reflect.deleteProperty(mediaFileProcessor, "metadataProcessInstance");
});

function stubRecognition(result: { type: "movie" | "tv_show"; identity: { title: string; year?: number } } | undefined) {
	activeStubs.push(
		stubMethod(recognitionService, "recognize", () => result),
		stubMethod(pluginsService, "transformRecognitionCandidate", (candidate: unknown) => candidate),
	);
}

function stubHappyPaths() {
	activeStubs.push(
		stubMethod(mediaRepository, "findIdByFilePath", () => Promise.resolve(undefined)),
		stubMethod(FileUtils, "getStats", () => Promise.resolve({ size: 12_345, mtimeMs: 1234.7 })),
	);
}

describe("mediaFileProcessor.process", () => {
	test("rejects an empty filePath", async () => {
		await expect(mediaFileProcessor.process("movie", "")).rejects.toThrow("filePath is required");
	});

	test("propagates an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(mediaFileProcessor.process("movie", "/media/movie.mkv", true, controller.signal)).rejects.toThrow();
	});

	test("returns null when the file is already registered", async () => {
		activeStubs.push(stubMethod(mediaRepository, "findIdByFilePath", () => Promise.resolve("existing-id")));

		await expect(mediaFileProcessor.process("movie", "/media/movie.mkv")).resolves.toBeNull();
	});

	test("reports recognition_failed when recognition finds no structure", async () => {
		stubRecognition(undefined);
		activeStubs.push(stubMethod(mediaRepository, "findIdByFilePath", () => Promise.resolve(undefined)));

		await expect(mediaFileProcessor.process("movie", "/media/movie.mkv")).resolves.toEqual({
			skipReason: "recognition_failed",
			fileName: "movie.mkv",
		});
	});

	test("reports type_mismatch on a library type mismatch", async () => {
		stubRecognition({ type: "movie", identity: { title: "Movie", year: 2020 } });
		activeStubs.push(stubMethod(mediaRepository, "findIdByFilePath", () => Promise.resolve(undefined)));

		await expect(mediaFileProcessor.process("tv_show", "/media/movie.mkv")).resolves.toEqual({
			skipReason: "type_mismatch",
			fileName: "movie.mkv",
		});
	});

	test("reports no_metadata_match when metadata resolution yields no id", async () => {
		stubRecognition({ type: "movie", identity: { title: "Movie", year: 2020 } });
		stubHappyPaths();
		Reflect.set(mediaFileProcessor, "metadataProcessInstance", {
			checkMetadata: (input: Record<string, unknown>) => {
				checkMetadataCalls.push(input);

				return Promise.resolve({ metadataId: null, movieId: null, episodeId: null });
			},
		});

		await expect(mediaFileProcessor.process("movie", "/media/movie.mkv")).resolves.toEqual({
			skipReason: "no_metadata_match",
			fileName: "movie.mkv",
		});
	});

	test("maps a recognized movie with probe data and chapter markers", async () => {
		stubRecognition({ type: "movie", identity: { title: "Movie", year: 2020 } });
		stubHappyPaths();
		const probe: FFProbeResult = {
			streams: [],
			format: { duration: "90.000" },
			chapters: [
				{
					start_time: "00:00:00.000",
					end_time: "00:01:30.000",
					tags: { title: "Intro" },
				},
			],
		};
		activeStubs.push(stubMethod(videoParser, "probe", () => Promise.resolve(probe)));

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

	test("deduplicates concurrent processing of the same file", async () => {
		stubRecognition({ type: "movie", identity: { title: "Movie", year: 2020 } });
		stubHappyPaths();
		let releaseProbe: ((value: FFProbeResult | null) => void) | undefined;
		activeStubs.push(
			stubMethod(videoParser, "probe", () => {
				if (releaseProbe) return Promise.resolve(null);

				return new Promise<FFProbeResult | null>((resolve) => {
					releaseProbe = resolve;
				});
			}),
		);

		const first = mediaFileProcessor.process("movie", "/media/movie.mkv");
		await sleep(0);
		const second = mediaFileProcessor.process("movie", "/media/movie.mkv");
		releaseProbe?.(null);

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult).toBe(secondResult);
	});
});
