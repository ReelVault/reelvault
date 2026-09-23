import { type ApplicationContext, withDomainError } from "@/application/context";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { fileScannerService } from "@/modules/scanner/disk/file-scanner";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { trimAndFilter, unique } from "@/utils/array.utils";
import { createHash } from "@/utils/crypto.utils";
import { PathUtils } from "@/utils/path.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

const MKV_EXTENSION_PATTERN = "[mM][kK][vV]";

export interface LibraryErrorsCheckData {
	libraryPaths: string[];
}

interface LibraryErrorsCheckProblem {
	filePath: string;
	errors: string;
}

export interface LibraryErrorsCheckResult {
	libraryPaths: string[];
	scannedFiles: number;
	cleanFiles: number;
	problematicFiles: LibraryErrorsCheckProblem[];
}

export interface LibraryErrorsCheckTaskDependencies {
	findMkvFiles(libraryPaths: string[], signal?: AbortSignal): Promise<string[]>;
	checkFile(filePath: string, signal?: AbortSignal): Promise<string>;
}

const defaultDependencies: LibraryErrorsCheckTaskDependencies = {
	findMkvFiles: (libraryPaths, signal) =>
		fileScannerService.scan({ paths: libraryPaths, extensions: [MKV_EXTENSION_PATTERN], maxDepth: Number.POSITIVE_INFINITY, signal }),
	checkFile: async (filePath, signal) =>
		(await ffMpegService.runToCompletion(["-v", "error", "-i", filePath, "-f", "null", "-"], { signal, stdout: "ignore" })).stderr,
};

export function normalizeLibraryPaths(libraryPaths: string[]): string[] {
	return unique(trimAndFilter(libraryPaths), (libraryPath) => PathUtils.resolve(libraryPath)).toSorted();
}

export function createLibraryErrorsCheckDedupeKey(libraryPaths: string[]): string {
	return createHash("sha256")
		.update(JSON.stringify(normalizeLibraryPaths(libraryPaths)))
		.digest("hex");
}

// ─── Worker Definition ────────────────────────────────────────────────────────

export const libraryErrorsCheckWorker = createWorkerDefinition<LibraryErrorsCheckData>(
	"library-errors-check",
	() => serverConfig.workers.definitions.libraryErrorsCheck,
	async ({ data, logger, signal }) => await checkLibraryErrorsTask(data, { signal, logger }),
);

// ─── Task Function ────────────────────────────────────────────────────────────

export function checkLibraryErrorsTask(
	data: LibraryErrorsCheckData,
	context: ApplicationContext,
	dependencies: LibraryErrorsCheckTaskDependencies = defaultDependencies,
): Promise<LibraryErrorsCheckResult> {
	return withDomainError("Library FFmpeg error check failed", async () => {
		context.signal?.throwIfAborted();
		const libraryPaths = normalizeLibraryPaths(data.libraryPaths);
		const filePaths = await dependencies.findMkvFiles(libraryPaths, context.signal);
		const problematicFiles: LibraryErrorsCheckProblem[] = [];

		// Run a small batch of FFmpeg full-decode checks in parallel. Sequential
		// processing one-by-one is the main cause of this task taking hours on
		// large libraries; the batch size derives from measured CPU capacity so
		// weak boxes never run more FFmpeg decodes than they have cores for.
		await PromiseUtils.mapConcurrent(
			filePaths,
			systemResourcesService.getHeavySubprocessConcurrency(),
			async (filePath, index) => {
				context.signal?.throwIfAborted();
				context.logger?.debug("Checking media file for FFmpeg errors", {
					filePath,
					fileNumber: index + 1,
					totalFiles: filePaths.length,
				});

				const errors = (await dependencies.checkFile(filePath, context.signal)).trim();
				if (!errors) return;

				problematicFiles.push({ filePath, errors });
				context.logger?.warn("FFmpeg errors found in media file", { filePath, errorLength: errors.length });
			},
			context.signal,
		);

		const result = {
			libraryPaths,
			scannedFiles: filePaths.length,
			cleanFiles: filePaths.length - problematicFiles.length,
			problematicFiles,
		};
		context.logger?.info("Library FFmpeg error check completed", {
			libraryPathCount: libraryPaths.length,
			scannedFiles: result.scannedFiles,
			problematicFiles: result.problematicFiles.length,
		});

		return result;
	});
}

// ─── Enqueue Function ─────────────────────────────────────────────────────────

export function enqueueLibraryErrorsCheck(data: LibraryErrorsCheckData, options: WorkerEnqueueOptions = {}) {
	const libraryPaths = normalizeLibraryPaths(data.libraryPaths);
	const dedupeKey = createLibraryErrorsCheckDedupeKey(libraryPaths);

	return workerService.addItem(
		libraryErrorsCheckWorker.id,
		{ libraryPaths },
		{
			...options,
			dedupeKey,
			reference: { type: "library-errors", id: dedupeKey },
		},
	);
}
