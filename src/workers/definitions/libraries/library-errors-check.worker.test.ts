import { afterEach, describe, expect, test } from "bun:test";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { fileScannerService } from "@/modules/scanner/disk/file-scanner";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { checkLibraryErrorsTask, createLibraryErrorsCheckDedupeKey } from "./library-errors-check.worker";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

describe("library error check task", () => {
	test("checks every discovered MKV and returns FFmpeg errors with file paths", async () => {
		const checked: string[] = [];
		activeStubs.push(
			stubMethod(fileScannerService, "scan", (options: { paths: string[] }) => {
				expect(options.paths).toEqual(["/media/movies"]);

				return Promise.resolve(["/media/movies/clean.mkv", "/media/movies/broken.MkV"]);
			}),
			stubMethod(ffMpegService, "runToCompletion", (args: string[]) => {
				const filePath = args[3] ?? "";
				checked.push(filePath);

				return Promise.resolve({
					exitCode: 0,
					stdout: new Uint8Array(),
					stderr: filePath.endsWith("broken.MkV") ? "[matroska] damaged frame" : "",
				});
			}),
		);

		await expect(checkLibraryErrorsTask({ libraryPaths: ["/media/movies", "/media/movies"] }, {})).resolves.toEqual({
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
