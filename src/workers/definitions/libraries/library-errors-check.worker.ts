import { resolve } from "node:path";
import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { ffMpegService } from "@/integrations/ffmpeg/ffmpeg.service";
import { fileScannerService } from "@/modules/scanner/disk/file.scanner";
import { trimAndFilter, unique } from "@/utils/array.utils";
import { createHash } from "@/utils/crypto.utils";
import { withDomainError } from "@/utils/domain.errors";
import { mapConcurrent } from "@/utils/promise.utils";
import type { ApplicationContext } from "@/utils/task-context.types";
import { defineWorkerEnqueue } from "@/workers/utils/worker-enqueue.utils";
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

export function normalizeLibraryPaths(libraryPaths: string[]): string[] {
	return unique(trimAndFilter(libraryPaths), (libraryPath) => resolve(libraryPath)).toSorted();
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

export function checkLibraryErrorsTask(data: LibraryErrorsCheckData, context: ApplicationContext): Promise<LibraryErrorsCheckResult> {
	return withDomainError("Library FFmpeg error check failed", async () => {
		context.signal?.throwIfAborted();
		const libraryPaths = normalizeLibraryPaths(data.libraryPaths);
		const filePaths = await fileScannerService.scan({
			paths: libraryPaths,
			extensions: [MKV_EXTENSION_PATTERN],
			maxDepth: Number.POSITIVE_INFINITY,
			signal: context.signal,
		});
		const problematicFiles: LibraryErrorsCheckProblem[] = [];

		// Run a small batch of FFmpeg full-decode checks in parallel. Sequential
		// processing one-by-one is the main cause of this task taking hours on
		// large libraries; the batch size derives from measured CPU capacity so
		// weak boxes never run more FFmpeg decodes than they have cores for.
		await mapConcurrent(
			filePaths,
			systemResourcesService.getHeavySubprocessConcurrency(),
			async (filePath, index) => {
				context.signal?.throwIfAborted();
				context.logger?.debug("Checking media file for FFmpeg errors", {
					filePath,
					fileNumber: index + 1,
					totalFiles: filePaths.length,
				});

				const errors = (
					await ffMpegService.runToCompletion(["-v", "error", "-i", filePath, "-f", "null", "-"], {
						signal: context.signal,
						stdout: "ignore",
					})
				).stderr.trim();
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

const libraryErrorsCheckEnqueue = defineWorkerEnqueue<{ libraryPaths: string[] }>(libraryErrorsCheckWorker.id, (data) => {
	const dedupeKey = createLibraryErrorsCheckDedupeKey(data.libraryPaths);

	return { dedupeKey, reference: { type: "library-errors", id: dedupeKey } };
});

export function enqueueLibraryErrorsCheck(data: LibraryErrorsCheckData, options: WorkerEnqueueOptions = {}) {
	return libraryErrorsCheckEnqueue.enqueue({ libraryPaths: normalizeLibraryPaths(data.libraryPaths) }, options);
}
