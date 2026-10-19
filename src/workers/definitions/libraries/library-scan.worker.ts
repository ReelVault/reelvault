import type { LibraryWithRelations } from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";
import { LIBRARY_SCAN_PRIORITY, MINUTE } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { scannerService } from "@/modules/scanner/scanner.service";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { throwIfAborted } from "@/utils/cancellation.utils";
import { KeyedMutex } from "@/utils/concurrency.utils";
import { assertFound, toDomainError } from "@/utils/domain.errors";
import { PromiseUtils } from "@/utils/promise.utils";
import type { ApplicationContext, TaskSchedulingOptions } from "@/utils/task-context.types";
import { mapLibraryType } from "@/utils/type.utils";
import type { MediaFileIngestData } from "@/workers/definitions/media/media-file-ingest/media-file-ingest.types";
import { enqueueManyMediaFileIngest, enqueueMediaFileIngest } from "@/workers/definitions/media/media-file-ingest.worker";
import { enqueueMediaFileRefreshBatch } from "@/workers/definitions/media/media-file-refresh-batch.service";
import { batchChunks } from "@/workers/utils/batch-chunker.utils";
import { toTaskSchedulingOptions } from "@/workers/utils/task-scheduling.mapper";
import { ENQUEUE_BATCH_SIZE } from "@/workers/worker.constants";
import { type ScanCheckpoint, workerDependencies } from "@/workers/worker.ports";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

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
	removedFiles: number;
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
	): Promise<{ filePaths: string[]; newFilePaths: string[]; changedMediaFileIds: string[]; removedFilePaths: string[] }>;
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
	findLibrary: (libraryId) => workerDependencies().libraries.findWithPaths(libraryId),
	scanPaths: (libraryId, type, paths, signal) => scannerService.scanPaths(libraryId, type, paths, signal),
	enqueueMediaFileIngest: (data, options) => enqueueMediaFileIngest(data, options ?? {}),
	enqueueMediaFileRefresh: (mediaFileId, options) => workerDependencies().services.mediaFileRefresh.queue(mediaFileId, options),
	enqueueMediaFileIngestBatch: (entries, options) => enqueueManyMediaFileIngest(entries, options ?? {}),
	enqueueMediaFileRefreshBatch: async (mediaFileIds, options, signal) => {
		throwIfAborted(signal);
		const targets = await workerDependencies().media.findIdentitiesByIds(mediaFileIds);

		return enqueueMediaFileRefreshBatch(targets, options ?? {});
	},
	publishScanStarted: (input) => pluginEventBus.publish("library.scan.started", input),
	emitScanCompleted: (input) => pluginEventBus.emit("library.scan.completed", input),
	notifyScanCompleted: (input) => realtimeService.broadcast("library:scan:completed", input),
	loadCheckpoint: (libraryId) => workerDependencies().scanState.get(libraryId),
	saveCheckpoint: (libraryId, checkpoint) => workerDependencies().scanState.set(libraryId, checkpoint),
	updateCheckpointCursors: (libraryId, cursors) => workerDependencies().scanState.setCursors(libraryId, cursors),
	deleteCheckpoint: (libraryId) => workerDependencies().scanState.delete(libraryId),
	pruneScanFindings: (libraryId, scannedFilePaths, scannedRoots) =>
		workerDependencies().scanFindings.pruneStale(libraryId, scannedFilePaths, scannedRoots),
};

export interface LibraryScanOrchestration {
	operationId?: string | undefined;
	taskId?: string | undefined;
}

// ─── Worker Definition ────────────────────────────────────────────────────────

export const libraryScanWorker = createWorkerDefinition<LibraryScanData>(
	"library-scan",
	() => serverConfig.workers.definitions.libraryScan,
	async ({ data, logger, signal, operationId, taskId, extendTimeout, updateProgress }) =>
		await scanLibraryTask(
			data,
			{ signal, logger, operationId, correlationId: operationId, taskId, extendTimeout, updateProgress },
			defaultDependencies,
			{ operationId, taskId },
		),
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
const libraryRunLock = new KeyedMutex();

export function scanLibraryTask(
	data: LibraryScanData,
	context: ApplicationContext,
	dependencies: LibraryScanTaskDependencies = defaultDependencies,
	orchestration: LibraryScanOrchestration = {},
): Promise<LibraryScanResults> {
	return libraryRunLock.runExclusive(data.libraryId, () => runScanLibraryTask(data, context, dependencies, orchestration));
}

/** Mutable scan progress — cursors advance as batches are enqueued and persisted. */
interface ScanEnqueueState {
	pathsSignature: string;
	scannedFiles: number;
	newFilePaths: string[];
	changedMediaFileIds: string[];
	removedFilePaths: string[];
	ingestCursor: number;
	refreshCursor: number;
}

interface ScanWork {
	libraryType: "movie" | "tv_show";
	pathsToScan: string[];
	pathsSignature: string;
}

interface IngestScope {
	taskScheduling: TaskSchedulingOptions;
	context: ApplicationContext;
	dependencies: LibraryScanTaskDependencies;
}

interface ChunkPlan<T> {
	items: readonly T[];
	cursor: number;
	setCursor: (cursor: number) => void;
	batch: ((chunk: T[]) => Promise<unknown>) | undefined;
	item: (entry: T) => Promise<unknown>;
	persist: () => Promise<void>;
}

/** Restores an interrupted scan's state or performs a fresh path scan and arms its checkpoint. */
async function resolveScanWorkload(
	data: LibraryScanData,
	work: ScanWork,
	context: ApplicationContext,
	dependencies: LibraryScanTaskDependencies,
): Promise<ScanEnqueueState> {
	const { libraryType, pathsToScan, pathsSignature } = work;
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
		removedFilePaths: scanResult.removedFilePaths,
		ingestCursor: 0,
		refreshCursor: 0,
	};
}

/** Only the cursors change per batch — rewriting the full path arrays each
 * time made checkpoint I/O quadratic in the file count. The enqueue progress
 * is reported right after each save. */
async function persistScanCursors(
	state: ScanEnqueueState,
	libraryId: string,
	dependencies: LibraryScanTaskDependencies,
	context: ApplicationContext,
): Promise<void> {
	if (dependencies.updateCheckpointCursors) {
		await dependencies.updateCheckpointCursors(libraryId, { ingestCursor: state.ingestCursor, refreshCursor: state.refreshCursor });
	} else {
		await dependencies.saveCheckpoint(libraryId, { ...state });
	}
	await reportEnqueueProgress(state, context);
}

/**
 * Percent of the enqueue workload already handed to the queues. Discovery has no
 * total yet, so a scan reports nothing until its enqueue phase starts.
 */
async function reportEnqueueProgress(state: ScanEnqueueState, context: ApplicationContext): Promise<void> {
	const total = state.newFilePaths.length + state.changedMediaFileIds.length;
	if (total === 0) return;

	const done = state.ingestCursor + state.refreshCursor;
	await context.updateProgress?.(Math.min(100, Math.floor((done * 100) / total)));
}

/**
 * Enqueues one workload's remaining items in resumable batches. The batched
 * variant is used preferentially (per-item fan-out only for custom dependencies
 * — unbounded concurrent inserts lock up single-writer SQLite); the cursor is
 * persisted after each chunk and every finished chunk re-arms the stall guard.
 */
async function enqueueInChunks<T>(plan: ChunkPlan<T>, context: ApplicationContext): Promise<void> {
	const { items, cursor, setCursor, batch, item, persist } = plan;
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
	scope: IngestScope,
): Promise<void> {
	const { taskScheduling, context, dependencies } = scope;
	const enqueueBatch = dependencies.enqueueMediaFileIngestBatch?.bind(dependencies);
	let enqueueChunk: ((chunk: string[]) => Promise<unknown>) | undefined;
	if (enqueueBatch) {
		enqueueChunk = (chunk) =>
			enqueueBatch(
				chunk.map((filePath) => ({ libraryId: data.libraryId, libraryType, filePath })),
				taskScheduling,
			);
	}
	await enqueueInChunks(
		{
			items: state.newFilePaths,
			cursor: state.ingestCursor,
			setCursor: (cursor) => {
				state.ingestCursor = cursor;
			},
			batch: enqueueChunk,
			item: (filePath) => dependencies.enqueueMediaFileIngest({ libraryId: data.libraryId, libraryType, filePath }, taskScheduling),
			persist: () => persistScanCursors(state, data.libraryId, dependencies, context),
		},
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
		{
			items: state.changedMediaFileIds,
			cursor: state.refreshCursor,
			setCursor: (cursor) => {
				state.refreshCursor = cursor;
			},
			batch: enqueueBatch ? (chunk) => enqueueBatch(chunk, taskScheduling, context.signal) : undefined,
			item: (mediaFileId) => dependencies.enqueueMediaFileRefresh(mediaFileId, taskScheduling),
			persist: () => persistScanCursors(state, data.libraryId, dependencies, context),
		},
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

		const state = await resolveScanWorkload(data, { libraryType, pathsToScan, pathsSignature }, context, dependencies);
		await enqueueIngestWork(state, data, libraryType, { taskScheduling, context, dependencies });
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
			removedFiles: state.removedFilePaths.length,
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

export async function enqueueLibraryScan(
	data: LibraryScanData,
	options: WorkerEnqueueOptions = {},
	/** Override for catch-up scans that must not collide with the primary scan's key. */
	dedupeKey?: string,
): Promise<LibraryScanSchedule> {
	const task = await workerService.addItem(libraryScanWorker.id, data, {
		...options,
		priority: options.priority ?? LIBRARY_SCAN_PRIORITY,
		dedupeKey: dedupeKey ?? `${data.libraryId}:${data.pathId ?? "all"}`,
		reference: { type: "library", id: data.libraryId },
	});

	return { operationId: task.operationId ?? undefined, taskId: task.id };
}
