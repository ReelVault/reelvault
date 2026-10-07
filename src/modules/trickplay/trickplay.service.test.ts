import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { mediaArtifactsService } from "@/modules/artifacts/media-artifacts.service";
import { DirUtils } from "@/utils/directory.utils";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { trickplayService } from "./trickplay.service";

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	activeStubs.length = 0;
	mediaArtifactsService.invalidateByteTotals();
});

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();
});

function stubMediaFile(): void {
	activeStubs.push(
		stubMethod(mediaRepository, "findByPrimaryId", () => Promise.resolve({ id: "mf-1", filePath: "/media/movie.mkv", duration: 3600 })),
	);
}

describe("trickplayService.generateForMediaFile — storage budget", () => {
	test("skips without deleting existing artifacts when core storage is over budget", async () => {
		const deleteCalls: unknown[][] = [];
		stubMediaFile();
		activeStubs.push(
			stubMethod(mediaArtifactsService, "getStoredBytes", () => Promise.resolve(Number.MAX_SAFE_INTEGER)),
			stubMethod(mediaArtifactsService, "getMediaFileStoredBytes", () => Promise.resolve(0)),
			stubMethod(mediaArtifactsService, "deleteByMediaFileIdAndKind", (...args: never[]) => {
				deleteCalls.push([...args]);

				return Promise.resolve(0);
			}),
		);

		const result = await trickplayService.generateForMediaFile("mf-1");

		expect(result).toEqual({ mediaFileId: "mf-1", frames: 0, sprites: 0, skipped: "storage-budget" });
		expect(deleteCalls).toHaveLength(0);
	});

	test("still regenerates when dropping this file's own artifacts fits the budget", async () => {
		stubMediaFile();
		activeStubs.push(
			// One byte above the total, but this file owns nearly all of it — a
			// regeneration frees those bytes first, so generation must proceed.
			stubMethod(mediaArtifactsService, "getStoredBytes", () => Promise.resolve(Number.MAX_SAFE_INTEGER)),
			stubMethod(mediaArtifactsService, "getMediaFileStoredBytes", () => Promise.resolve(Number.MAX_SAFE_INTEGER - 1)),
			stubMethod(mediaArtifactsService, "deleteByMediaFileIdAndKind", () => Promise.resolve(0)),
			stubMethod(DirUtils, "create", () => Promise.resolve(true)),
			stubMethod(DirUtils, "delete", () => Promise.resolve()),
			stubMethod(ffMpegService, "runToCompletion", () => Promise.resolve({ exitCode: 1, stderr: "stub failure" })),
		);

		await expect(trickplayService.generateForMediaFile("mf-1")).rejects.toMatchObject({
			code: "trickplay_extraction_failed",
		});
	});
});
