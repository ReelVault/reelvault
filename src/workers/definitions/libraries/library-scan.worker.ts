import type { LibraryWithRelations } from "@reelvault/sdk/common";
import { type ApplicationContext, type TaskSchedulingOptions, toDomainError } from "@/application/context";
import { mediaFileRefreshService } from "@/application/media/media-files/refresh-media-file.operation";
import { pluginsService } from "@/application/plugins.service";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { scanFindingsRepository } from "@/database/repositories/scan-findings.repository";
import { type ScanCheckpoint, scanStateRepository } from "@/database/repositories/scan-state.repository";
import { realtimeService } from "@/modules/realtime";
import { scannerService } from "@/modules/scanner/scanner.service";
import { serverConfig } from "@/server.config";
import { MINUTE } from "@/server.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { assertFound } from "@/utils/errors";
import { PromiseUtils } from "@/utils/promise.utils";
import { mapLibraryType } from "@/utils/type.utils";
import { batchChunks } from "@/workers/utils/batch-chunker";
import { toTaskSchedulingOptions } from "@/workers/utils/task-scheduling.mapper";
import { throwIfAborted } from "@/workers/utils/worker-cancellation";
import { ENQUEUE_BATCH_SIZE } from "@/workers/worker.constants";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";
import { enqueueManyMediaFileIngest, enqueueMediaFileIngest, type MediaFileIngestData } from "../media/media-file-ingest.worker";
import { enqueueMediaFileRefreshBatch } from "../media/media-file-refresh-batch";
import { LibraryRunLock } from "./library-run.lock";

export interface LibraryScanData {
	libraryId: string;
	paths?: string[] | undefined;
	pathId?: string | undefined;
}

export interface LibraryScanResults {
	libraryId: string;
	scannedFiles: number;
	createdFiles: number;
	existingFiles: number;
	failedFiles: number;
	analyzedFiles: number;
}

export interface LibraryScanSchedule {
	operationId?: string | undefined;
	taskId: string;
}

export interface LibraryScanTaskDependencies {
	findLibrary(libraryId: string): Promise<LibraryWithRelations | undefined>;
	scanPaths(
		libraryId: string,
		type: "movie" | "tv_show",
		paths: string[],
		signal?: AbortSignal,
	): Promise<{ filePaths: string[]; newFilePaths: string[]; changedMediaFileIds: string[] }>;
	enqueueMediaFileIngest(data: MediaFileIngestData, options?: TaskSchedulingOptions): Promise<{ id: string }>;
	enqueueMediaFileRefresh(mediaFileId: string, options?: TaskSchedulingOptions): Promise<unknown>;
	/** Optional batched variants — used preferentially to avoid one INSERT per file. */
	enqueueMediaFileIngestBatch?(entries: MediaFileIngestData[], options?: TaskSchedulingOptions): Promise<unknown>;
	enqueueMediaFileRefreshBatch?(mediaFileIds: string[], options?: TaskSchedulingOptions, signal?: AbortSignal): Promise<unknown>;
	publishScanStarted(input: { libraryId: string; scanId: string; correlationId: string }): void;
	emitScanCompleted(input: { libraryId: string; scanId: string; errors: number; correlationId: string }): Promise<void>;
	/** Pushes `library:scan:completed` to connected realtime clients (web/mobile UIs invalidate their catalog caches). */
	notifyScanCompleted(input: { libraryId: string; libraryTitle?: string }): void;
	/** Resume checkpoint (W6): survives a cancelled scan so its enqueue phase can be finished later. */
	loadCheckpoint(libraryId: string): Promise<ScanCheckpoint | undefined>;
	saveCheckpoint(libraryId: string, checkpoint: ScanCheckpoint): Promise<void>;
	updateCheckpointCursors?(libraryId: string, cursors: { ingestCursor: number; refreshCursor: number }): Promise<void>;
	deleteCheckpoint(libraryId: string): Promise<void>;
	/** Drops findings for files inside the scanned roots that this scan no longer sees. */
	pruneScanFindings?(libraryId: string, scannedFilePaths: readonly string[], scannedRoots: readonly string[]): Promise<void>;
}

const defaultDependencies: LibraryScanTaskDependencies = {
	findLibrary: (libraryId) => librariesRepository.findWithPaths(libraryId),
	scanPaths: (libraryId, type, paths, signal) => scannerService.scanPaths(libraryId, type, paths, signal),
	enqueueMediaFileIngest: (data, options) => enqueueMediaFileIngest(data, options ?? {}),
	enqueueMediaFileRefresh: (mediaFileId, options) => mediaFileRefreshService.queue(mediaFileId, options),
	enqueueMediaFileIngestBatch: (entries, options) => enqueueManyMediaFileIngest(entries, options ?? {}),
	enqueueMediaFileRefreshBatch: async (mediaFileIds, options, signal) => {
		throwIfAborted(signal);
		const targets = await mediaRepository.findIdentitiesByIds(mediaFileIds);

		return enqueueMediaFileRefreshBatch(targets, options ?? {});
	},
	publishScanStarted: (input) => pluginsService.publish("library.scan.started", input),
	emitScanCompleted: (input) => pluginsService.emit("library.scan.completed", input),
	notifyScanCompleted: (input) => realtimeService.broadcast("library:scan:completed", input),
	loadCheckpoint: (libraryId) => scanStateRepository.get(libraryId),
	saveCheckpoint: (libraryId, checkpoint) => scanStateRepository.set(libraryId, checkpoint),
	updateCheckpointCursors: (libraryId, cursors) => scanStateRepository.setCursors(libraryId, cursors),
	deleteCheckpoint: (libraryId) => scanStateRepository.delete(libraryId),
	pruneScanFindings: (libraryId, scannedFilePaths, scannedRoots) =>
		scanFindingsRepository.pruneStale(libraryId, scannedFilePaths, scannedRoots),
};

export interface LibraryScanOrchestration {
	operationId?: string | undefined;
	taskId?: string | undefined;
}

// ─── Worker Definition ────────────────────────────────────────────────────────

export const libraryScanWorker = createWorkerDefinition<LibraryScanData>(
	"library-scan",
	() => serverConfig.workers.definitions.libraryScan,
	async ({ data, logger, signal, operationId, taskId, extendTimeout }) =>
		await scanLibraryTask(data, { signal, logger, operationId, correlationId: operationId, taskId, extendTimeout }, defaultDependencies, {
			operationId,
			taskId,
		}),
);

// ─── Task Function ────────────────────────────────────────────────────────────

/**
 * Once the diff is known, the enqueue phase re-arms the stall guard with this
 * floor plus a per-item margin; every finished chunk buys another window, so
 * the timeout aborts only a genuinely stuck scan — never a big-but-progressing one.
 */
const ENQUEUE_TIMEOUT_FLOOR_MS = 30 * MINUTE;
const ENQUEUE_TIMEOUT_PER_ITEM_MS = 250;
const ENQUEUE_CHUNK_TIMEOUT_MS = 15 * MINUTE;

/** Serializes scans per library — a watcher-triggered scan must not interleave with a scheduled one. */
const libraryRunLock = new LibraryRunLock();

export function scanLibraryTask(
	data: LibraryScanData,
	context: ApplicationContext,
	dependencies: LibraryScanTaskDependencies = defaultDependencies,
	orchestration: LibraryScanOrchestration = {},
): Promise<LibraryScanResults> {
	return libraryRunLock.run(data.libraryId, () => runScanLibraryTask(data, context, dependencies, orchestration));
}

async function runScanLibraryTask(
	data: LibraryScanData,
	context: ApplicationContext,
	dependencies: LibraryScanTaskDependencies,
	orchestration: LibraryScanOrchestration,
): Promise<LibraryScanResults> {
	const operationId = orchestration.operationId ?? context.correlationId ?? data.libraryId;
	const taskScheduling = toTaskSchedulingOptions(orchestration);
	try {
		context.signal?.throwIfAborted();
		dependencies.publishScanStarted({ libraryId: data.libraryId, scanId: operationId, correlationId: operationId });

		const library = await dependencies.findLibrary(data.libraryId);
		assertFound(library, "Library", data.libraryId);

		const pathsToScan = data.paths && data.paths.length > 0 ? data.paths : library.paths.map((p) => p.path);
		const pathsSignature = pathsToScan.join("\n");
		const libraryType = mapLibraryType(library.type);

		let scannedFiles: number;
		let newFilePaths: string[];
		let changedMediaFileIds: string[];
		let ingestCursor = 0;
		let refreshCursor = 0;

		const checkpoint = await dependencies.loadCheckpoint(data.libraryId);
		const resumable =
			checkpoint?.pathsSignature === pathsSignature &&
			(checkpoint.ingestCursor < checkpoint.newFilePaths.length || checkpoint.refreshCursor < checkpoint.changedMediaFileIds.length);

		if (checkpoint && !resumable) await dependencies.deleteCheckpoint(data.libraryId);

		if (checkpoint && resumable) {
			// A previous scan of the same paths was interrupted mid-enqueue — finish
			// its remainder instead of silently dropping it.
			context.logger?.info("Resuming interrupted library scan", {
				libraryId: data.libraryId,
				ingestRemaining: checkpoint.newFilePaths.length - checkpoint.ingestCursor,
				refreshRemaining: checkpoint.changedMediaFileIds.length - checkpoint.refreshCursor,
			});
			scannedFiles = checkpoint.scannedFiles;
			newFilePaths = checkpoint.newFilePaths;
			changedMediaFileIds = checkpoint.changedMediaFileIds;
			ingestCursor = checkpoint.ingestCursor;
			refreshCursor = checkpoint.refreshCursor;
		} else {
			const scanResult = await dependencies.scanPaths(data.libraryId, libraryType, pathsToScan, context.signal);
			context.signal?.throwIfAborted();
			await dependencies.pruneScanFindings?.(data.libraryId, scanResult.filePaths, pathsToScan);
			scannedFiles = scanResult.filePaths.length;
			newFilePaths = scanResult.newFilePaths;
			changedMediaFileIds = scanResult.changedMediaFileIds;
			// Checkpoint before the first enqueue — an abort from here on is resumable.
			await dependencies.saveCheckpoint(data.libraryId, {
				pathsSignature,
				scannedFiles,
				newFilePaths,
				changedMediaFileIds,
				ingestCursor,
				refreshCursor,
			});
			// Workload is now known — re-arm the stall guard for the enqueue phase.
			context.extendTimeout?.(ENQUEUE_TIMEOUT_FLOOR_MS + (newFilePaths.length + changedMediaFileIds.length) * ENQUEUE_TIMEOUT_PER_ITEM_MS);
		}

		const checkpointCursors = async () => {
			// Only the cursors change per batch — rewriting the full path arrays each
			// time made checkpoint I/O quadratic in the file count.
			if (dependencies.updateCheckpointCursors) {
				await dependencies.updateCheckpointCursors(data.libraryId, { ingestCursor, refreshCursor });
			} else {
				await dependencies.saveCheckpoint(data.libraryId, {
					pathsSignature,
					scannedFiles,
					newFilePaths,
					changedMediaFileIds,
					ingestCursor,
					refreshCursor,
				});
			}
		};

		// Batched path (one INSERT batch per ~500 files) when the dependency supports
		// it; the per-item mapConcurrent path stays for custom dependencies. Both avoid
		// firing thousands of concurrent DB inserts at once (SQLite is single-writer —
		// unbounded fan-out causes lock contention and blocks the event loop).
		if (dependencies.enqueueMediaFileIngestBatch) {
			for (const { items: filePathChunk, nextCursor } of batchChunks(newFilePaths, ENQUEUE_BATCH_SIZE, ingestCursor)) {
				context.signal?.throwIfAborted();
				await dependencies.enqueueMediaFileIngestBatch(
					filePathChunk.map((filePath) => ({ libraryId: data.libraryId, libraryType, filePath })),
					taskScheduling,
				);
				ingestCursor = nextCursor;
				await checkpointCursors();
				context.extendTimeout?.(ENQUEUE_CHUNK_TIMEOUT_MS);
			}
		} else {
			await PromiseUtils.mapConcurrent(
				newFilePaths.slice(ingestCursor),
				systemResourcesService.getIngestConcurrency(),
				(filePath) => dependencies.enqueueMediaFileIngest({ libraryId: data.libraryId, libraryType, filePath }, taskScheduling),
				context.signal,
			);
			ingestCursor = newFilePaths.length;
			await checkpointCursors();
		}

		if (dependencies.enqueueMediaFileRefreshBatch) {
			for (const { items: mediaFileIdChunk, nextCursor } of batchChunks(changedMediaFileIds, ENQUEUE_BATCH_SIZE, refreshCursor)) {
				context.signal?.throwIfAborted();
				await dependencies.enqueueMediaFileRefreshBatch(mediaFileIdChunk, taskScheduling, context.signal);
				refreshCursor = nextCursor;
				await checkpointCursors();
				context.extendTimeout?.(ENQUEUE_CHUNK_TIMEOUT_MS);
			}
		} else {
			await PromiseUtils.mapConcurrent(
				changedMediaFileIds.slice(refreshCursor),
				systemResourcesService.getIngestConcurrency(),
				(mediaFileId) => dependencies.enqueueMediaFileRefresh(mediaFileId, taskScheduling),
				context.signal,
			);
			refreshCursor = changedMediaFileIds.length;
			await checkpointCursors();
		}

		// Everything enqueued — the checkpoint has served its purpose.
		await dependencies.deleteCheckpoint(data.libraryId);
		await dependencies.emitScanCompleted({ libraryId: data.libraryId, scanId: operationId, errors: 0, correlationId: operationId });
		dependencies.notifyScanCompleted({ libraryId: data.libraryId, libraryTitle: library.name });
		const result = {
			libraryId: data.libraryId,
			scannedFiles,
			createdFiles: newFilePaths.length,
			existingFiles: scannedFiles - newFilePaths.length,
			failedFiles: 0,
			analyzedFiles: 0,
		};
		context.logger?.info("Library scan tasks queued", {
			...result,
			queuedIngestTasks: newFilePaths.length,
			queuedRefreshTasks: changedMediaFileIds.length,
		});

		return result;
	} catch (error) {
		// Emit even when aborted — downstream consumers must learn the scan ended
		// incomplete. A checkpoint persisted before the abort lets the next scan
		// of this library resume the enqueue phase instead of dropping it.
		try {
			await dependencies.emitScanCompleted({ libraryId: data.libraryId, scanId: operationId, errors: 1, correlationId: operationId });
			dependencies.notifyScanCompleted({ libraryId: data.libraryId });
		} catch (completionError) {
			context.logger?.error("Failed to publish failed library scan event", completionError, { libraryId: data.libraryId });
		}

		throw toDomainError(error, `Library scan failed: ${data.libraryId}`);
	}
}

// ─── Enqueue Function ─────────────────────────────────────────────────────────

export async function enqueueLibraryScan(data: LibraryScanData, options: WorkerEnqueueOptions = {}): Promise<LibraryScanSchedule> {
	const task = await workerService.addItem(libraryScanWorker.id, data, {
		...options,
		dedupeKey: `${data.libraryId}:${data.pathId ?? "all"}`,
		reference: { type: "library", id: data.libraryId },
	});

	return { operationId: task.operationId ?? undefined, taskId: task.id };
}
