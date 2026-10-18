import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { removeTreeSync } from "@/utils/directory.utils";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { checkLibraryErrorsTask, createLibraryErrorsCheckDedupeKey } from "./library-errors-check.worker";

const activeStubs: Array<{ restore(): void }> = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
	for (const directory of temporaryDirectories.splice(0)) removeTreeSync(directory);
});

/** A real library folder: two MKVs (one with an upper-case extension) and a file the scan must skip. */
function createLibraryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "reelvault-library-errors-"));
	temporaryDirectories.push(directory);
	writeFileSync(join(directory, "clean.mkv"), "matroska");
	writeFileSync(join(directory, "broken.MkV"), "matroska");
	writeFileSync(join(directory, "notes.txt"), "not media");

	return directory;
}

describe("library error check task", () => {
	test("checks every MKV in the library and reports FFmpeg errors with file paths", async () => {
		const library = createLibraryDirectory();
		const cleanPath = join(library, "clean.mkv");
		const brokenPath = join(library, "broken.MkV");
		const checked: string[] = [];
		activeStubs.push(
			// FFmpeg is the only process boundary here; the scan and the file list are real.
			stubMethod(ffMpegService, "runToCompletion", (args: string[]) => {
				const filePath = args[3] ?? "";
				checked.push(filePath);

				return Promise.resolve({
					exitCode: 0,
					stdout: new Uint8Array(),
					stderr: filePath === brokenPath ? "[matroska] damaged frame" : "",
				});
			}),
		);

		await expect(checkLibraryErrorsTask({ libraryPaths: [library, library] }, {})).resolves.toEqual({
			libraryPaths: [library],
			scannedFiles: 2,
			cleanFiles: 1,
			problematicFiles: [{ filePath: brokenPath, errors: "[matroska] damaged frame" }],
		});
		expect(checked.toSorted()).toEqual([cleanPath, brokenPath].toSorted());
	});

	test("uses the same dedupe key for equivalent path order", () => {
		expect(createLibraryErrorsCheckDedupeKey(["/media/tv", "/media/movies"])).toBe(
			createLibraryErrorsCheckDedupeKey(["/media/movies", "/media/tv"]),
		);
	});
});
