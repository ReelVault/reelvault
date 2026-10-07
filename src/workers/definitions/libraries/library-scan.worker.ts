import type { LibraryWithRelations } from "@reelvault/sdk/common";
import { type ApplicationContext, type TaskSchedulingOptions, toDomainError } from "@/application/context";
import { mediaFileRefreshService } from "@/application/media/media-files/refresh-media-file.operation";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { scanFindingsRepository } from "@/database/repositories/scan-findings.repository";
import { type ScanCheckpoint, scanStateRepository } from "@/database/repositories/scan-state.repository";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { scannerService } from "@/modules/scanner/scanner.service";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
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
	/**
	 * Interrupted-scan checkpoint: written during the enqueue phase and read on
	 * the next scan only to detect the interruption (and surface the pending
	 * counts) — the workload is always recomputed from disk, never resumed from
	 * the stale list.
	 */
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
	publishScanStarted: (input) => pluginEventBus.publish("library.scan.started", input),
	emitScanCompleted: (input) => pluginEventBus.emit("library.scan.completed", input),
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

/** Mutable scan progress — cursors advance as batches are enqueued and persisted. */
interface ScanEnqueueState {
	pathsSignature: string;
	scannedFiles: number;
	newFilePaths: string[];
	changedMediaFileIds: string[];
	ingestCursor: number;
	refreshCursor: number;
}

/** Restores an interrupted scan's state or performs a fresh path scan and arms its checkpoint. */
async function resolveScanWorkload(
	data: LibraryScanData,
	libraryType: "movie" | "tv_show",
	pathsToScan: string[],
	pathsSignature: string,
	context: ApplicationContext,
	dependencies: LibraryScanTaskDependencies,
): Promise<ScanEnqueueState> {
	const checkpoint = await dependencies.loadCheckpoint(data.libraryId);
	if (checkpoint) {
		// An interrupted scan left a checkpoint. Its file list is stale by
		// definition — files added since the interruption are missing, and files the
		// interrupted run already enqueued are still listed — so recompute the
		// workload from disk instead of resuming the old list. The disk diff is
		// cheap and always current; ingest dedupe covers already-enqueued files.
		context.logger?.info("Interrupted library scan detected — recomputing the workload from disk", {
			libraryId: data.libraryId,
			pendingIngest: checkpoint.newFilePaths.length - checkpoint.ingestCursor,
			pendingRefresh: checkpoint.changedMediaFileIds.length - checkpoint.refreshCursor,
		});
		await dependencies.deleteCheckpoint(data.libraryId);
	}

	const scanResult = await dependencies.scanPaths(data.libraryId, libraryType, pathsToScan, context.signal);
	context.signal?.throwIfAborted();
	await dependencies.pruneScanFindings?.(data.libraryId, scanResult.filePaths, pathsToScan);
	// Checkpoint before the first enqueue — a later interruption is detectable.
	await dependencies.saveCheckpoint(data.libraryId, {
		pathsSignature,
		scannedFiles: scanResult.filePaths.length,
		newFilePaths: scanResult.newFilePaths,
		changedMediaFileIds: scanResult.changedMediaFileIds,
		ingestCursor: 0,
		refreshCursor: 0,
	});
	// Workload is now known — re-arm the stall guard for the enqueue phase.
	context.extendTimeout?.(
		ENQUEUE_TIMEOUT_FLOOR_MS + (scanResult.newFilePaths.length + scanResult.changedMediaFileIds.length) * ENQUEUE_TIMEOUT_PER_ITEM_MS,
	);

	return {
		pathsSignature,
		scannedFiles: scanResult.filePaths.length,
		newFilePaths: scanResult.newFilePaths,
		changedMediaFileIds: scanResult.changedMediaFileIds,
		ingestCursor: 0,
		refreshCursor: 0,
	};
}

/** Only the cursors change per batch — rewriting the full path arrays each
 * time made checkpoint I/O quadratic in the file count. */
async function persistScanCursors(state: ScanEnqueueState, libraryId: string, dependencies: LibraryScanTaskDependencies): Promise<void> {
	if (dependencies.updateCheckpointCursors) {
		await dependencies.updateCheckpointCursors(libraryId, { ingestCursor: state.ingestCursor, refreshCursor: state.refreshCursor });
	} else {
		await dependencies.saveCheckpoint(libraryId, { ...state });
	}
}

/**
 * Enqueues one workload's remaining items in resumable batches. The batched
 * variant is used preferentially (per-item fan-out only for custom dependencies
 * — unbounded concurrent inserts lock up single-writer SQLite); the cursor is
 * persisted after each chunk and every finished chunk re-arms the stall guard.
 */
async function enqueueInChunks<T>(
	items: readonly T[],
	cursor: number,
	setCursor: (cursor: number) => void,
	batch: ((chunk: T[]) => Promise<unknown>) | undefined,
	item: (entry: T) => Promise<unknown>,
	persist: () => Promise<void>,
	context: ApplicationContext,
): Promise<void> {
	if (batch) {
		for (const { items: chunk, nextCursor } of batchChunks(items, ENQUEUE_BATCH_SIZE, cursor)) {
			context.signal?.throwIfAborted();
			await batch(chunk);
			setCursor(nextCursor);
			await persist();
			context.extendTimeout?.(ENQUEUE_CHUNK_TIMEOUT_MS);
		}

		return;
	}

	await PromiseUtils.mapConcurrent(items.slice(cursor), systemResourcesService.getIngestConcurrency(), item, context.signal);
	setCursor(items.length);
	await persist();
}

/** Enqueues new-file ingest work in resumable batches. */
async function enqueueIngestWork(
	state: ScanEnqueueState,
	data: LibraryScanData,
	libraryType: "movie" | "tv_show",
	taskScheduling: TaskSchedulingOptions,
	context: ApplicationContext,
	dependencies: LibraryScanTaskDependencies,
): Promise<void> {
	const enqueueBatch = dependencies.enqueueMediaFileIngestBatch?.bind(dependencies);
	await enqueueInChunks(
		state.newFilePaths,
		state.ingestCursor,
		(cursor) => {
			state.ingestCursor = cursor;
		},
		enqueueBatch
			? (chunk) =>
					enqueueBatch(
						chunk.map((filePath) => ({ libraryId: data.libraryId, libraryType, filePath })),
						taskScheduling,
					)
			: undefined,
		(filePath) => dependencies.enqueueMediaFileIngest({ libraryId: data.libraryId, libraryType, filePath }, taskScheduling),
		() => persistScanCursors(state, data.libraryId, dependencies),
		context,
	);
}

/** Enqueues technical-refresh work for changed files, mirroring the ingest batching. */
async function enqueueRefreshWork(
	state: ScanEnqueueState,
	data: LibraryScanData,
	taskScheduling: TaskSchedulingOptions,
	context: ApplicationContext,
	dependencies: LibraryScanTaskDependencies,
): Promise<void> {
	const enqueueBatch = dependencies.enqueueMediaFileRefreshBatch?.bind(dependencies);
	await enqueueInChunks(
		state.changedMediaFileIds,
		state.refreshCursor,
		(cursor) => {
			state.refreshCursor = cursor;
		},
		enqueueBatch ? (chunk) => enqueueBatch(chunk, taskScheduling, context.signal) : undefined,
		(mediaFileId) => dependencies.enqueueMediaFileRefresh(mediaFileId, taskScheduling),
		() => persistScanCursors(state, data.libraryId, dependencies),
		context,
	);
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

		const state = await resolveScanWorkload(data, libraryType, pathsToScan, pathsSignature, context, dependencies);
		await enqueueIngestWork(state, data, libraryType, taskScheduling, context, dependencies);
		await enqueueRefreshWork(state, data, taskScheduling, context, dependencies);

		// Everything enqueued — the checkpoint has served its purpose.
		await dependencies.deleteCheckpoint(data.libraryId);
		await dependencies.emitScanCompleted({ libraryId: data.libraryId, scanId: operationId, errors: 0, correlationId: operationId });
		dependencies.notifyScanCompleted({ libraryId: data.libraryId, libraryTitle: library.name });
		const result = {
			libraryId: data.libraryId,
			scannedFiles: state.scannedFiles,
			createdFiles: state.newFilePaths.length,
			existingFiles: state.scannedFiles - state.newFilePaths.length,
			failedFiles: 0,
			analyzedFiles: 0,
		};
		context.logger?.info("Library scan tasks queued", {
			...result,
			queuedIngestTasks: state.newFilePaths.length,
			queuedRefreshTasks: state.changedMediaFileIds.length,
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
