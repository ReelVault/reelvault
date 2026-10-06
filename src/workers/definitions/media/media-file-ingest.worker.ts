import type { CreateMediaFile, LibraryWithRelations } from "@reelvault/sdk/common";
import type { PluginEventInput } from "@reelvault/sdk/plugin";
import { type ApplicationContext, type TaskSchedulingOptions, toDomainError } from "@/application/context";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { mediaMarkersRepository } from "@/database/repositories/media-markers.repository";
import { scanFindingsRepository } from "@/database/repositories/scan-findings.repository";
import { SidecarMetadataStorageService } from "@/modules/metadata-sidecars/sidecar-metadata-storage.service";
import { sidecarMetadataWriter } from "@/modules/metadata-sidecars/sidecar-metadata-writer.runtime";
import { mediaFileProcessor } from "@/modules/scanner/processing/media-file-processor";
import { importSidecarSubtitles } from "@/modules/scanner/processing/sidecar-subtitles";
import type { ProcessedMediaFileWithMarkers, ScanFindingReason, SkippedMediaFile } from "@/modules/scanner/scanner.types";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { serverConfig } from "@/server.config";
import { assertFound } from "@/utils/errors";
import { MemoryCache } from "@/utils/memory-cache";
import { enqueueTrickplayGeneration } from "@/workers/definitions/media/trickplay-generate.worker";
import { toTaskSchedulingOptions } from "@/workers/utils/task-scheduling.mapper";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";
import { enqueueMediaFileAnalysis, type MediaFileAnalysisData } from "./media-file-analysis.worker";

export interface MediaFileIngestData {
	libraryId: string;
	libraryType: "movie" | "tv_show";
	filePath: string;
}

/**
 * One ingest job = one file, and every job needs the same immutable-during-scan
 * library row (paths + storage mode). Without this cache a 5000-file import
 * re-queried the library (plus its stats aggregate) 5000 times. Invalidated by
 * librariesService on update/delete.
 */
export const ingestLibraryCache = new MemoryCache<LibraryWithRelations>({
	ttlMs: 30_000,
	maxSize: 16,
	name: "ingest.library",
});

export interface MediaFileIngestResult {
	libraryId: string;
	filePath: string;
	mediaFileId: string | null;
	created: boolean;
	skipReason?: ScanFindingReason | undefined;
	analysisTaskId?: string | undefined;
}

export interface MediaFileIngestTaskDependencies {
	findLibrary(libraryId: string): Promise<LibraryWithRelations | undefined>;
	processFile(
		libraryType: "movie" | "tv_show",
		filePath: string,
		skipExistingLookup: boolean,
		signal?: AbortSignal,
		scheduling?: TaskSchedulingOptions,
		libraryId?: string,
	): Promise<ProcessedMediaFileWithMarkers | SkippedMediaFile | null>;
	upsertScanFinding(finding: { libraryId: string; filePath: string; fileName: string; reason: ScanFindingReason }): Promise<void>;
	deleteScanFinding(libraryId: string, filePath: string): Promise<void>;
	createMediaFile(data: CreateMediaFile): Promise<{ mediaFile: { id: string }; created: boolean }>;
	importSidecarSubtitles?(mediaFileId: string, videoFilePath: string): Promise<number>;
	findMediaByPaths(
		libraryId: string,
		filePaths: string[],
	): Promise<Array<{ filePath: string; metadataId: string; movieId: string | null; episodeId: string | null }>>;
	saveSidecars(
		library: LibraryWithRelations,
		mediaFiles: Array<{ filePath: string; metadataId: string; movieId: string | null; episodeId: string | null }>,
	): Promise<void>;
	emitMediaDiscovered(input: PluginEventInput<"media.file.discovered">): Promise<void>;
	emitMediaIdentified(input: PluginEventInput<"media.file.identified">): Promise<void>;
	/** Which post-create side effects already ran (used by the retry path). */
	readIngestProgress?(mediaFileId: string): Promise<{ sidecarWritten: boolean; discoveredEmitted: boolean }>;
	markSidecarWritten?(mediaFileId: string): Promise<void>;
	markDiscoveredEmitted?(mediaFileId: string): Promise<void>;
	enqueueAnalysis(data: MediaFileAnalysisData, options?: TaskSchedulingOptions): Promise<{ id: string }>;
	enqueueTrickplayGeneration(mediaFileId: string, options?: WorkerEnqueueOptions): Promise<unknown>;
}

const defaultDependencies: MediaFileIngestTaskDependencies = {
	findLibrary: async (libraryId) => {
		const cached = ingestLibraryCache.get(libraryId);
		if (cached) return cached;

		const library = await librariesRepository.findWithPaths(libraryId);
		if (library) ingestLibraryCache.set(libraryId, library);

		return library;
	},
	processFile: (libraryType, filePath, skipExistingLookup, signal, scheduling, libraryId) =>
		mediaFileProcessor.process(libraryType, filePath, skipExistingLookup, signal, scheduling, { libraryId }),
	upsertScanFinding: (finding) => scanFindingsRepository.upsert(finding),
	deleteScanFinding: (libraryId, filePath) => scanFindingsRepository.remove(libraryId, filePath),
	createMediaFile: (data) => mediaRepository.createWithStreams(data),
	importSidecarSubtitles: (mediaFileId, videoFilePath) => importSidecarSubtitles(mediaFileId, videoFilePath),
	findMediaByPaths: (libraryId, filePaths) => mediaRepository.findByLibraryAndPaths({ libraryId, filePaths }),
	saveSidecars: (library, mediaFiles) => new SidecarMetadataStorageService(sidecarMetadataWriter).saveLibraryMedia(library, mediaFiles),
	emitMediaDiscovered: (input) => pluginEventBus.emit("media.file.discovered", input),
	emitMediaIdentified: (input) => pluginEventBus.emit("media.file.identified", input),
	readIngestProgress: (mediaFileId) => mediaRepository.findIngestProgress(mediaFileId),
	markSidecarWritten: (mediaFileId) => mediaRepository.markIngestSidecarWritten(mediaFileId),
	markDiscoveredEmitted: (mediaFileId) => mediaRepository.markIngestDiscoveredEmitted(mediaFileId),
	enqueueTrickplayGeneration: (mediaFileId, options) => enqueueTrickplayGeneration(mediaFileId, options ?? {}),
	enqueueAnalysis: (data, options) => enqueueMediaFileAnalysis(data, options ?? {}),
};

export interface MediaFileIngestOrchestration {
	operationId?: string | undefined;
	taskId?: string | undefined;
	attempt?: number | undefined;
}

// ─── Worker Definition ────────────────────────────────────────────────────────

export const mediaFileIngestWorker = createWorkerDefinition<MediaFileIngestData>(
	"media-file-ingest",
	() => serverConfig.workers.definitions.mediaFileIngest,
	async ({ data, logger, signal, operationId, taskId, attempt }) =>
		await ingestMediaFileTask(data, { signal, logger, operationId, correlationId: operationId, taskId }, defaultDependencies, {
			operationId,
			taskId,
			attempt,
		}),
);

// ─── Task Function ────────────────────────────────────────────────────────────

/** Identity of one media-file row owned by the ingested file; a range file owns several. */
interface IngestTarget {
	mediaFileId: string;
	metadataId: string;
	movieId: string | null;
	episodeId: string | null;
}

/** State needed to finish an ingest after the media-file row exists. */
interface IngestCompletionInput {
	data: MediaFileIngestData;
	library: LibraryWithRelations;
	target: IngestTarget;
	context: ApplicationContext;
	orchestration: MediaFileIngestOrchestration;
	taskScheduling: TaskSchedulingOptions;
}

/** A file matched an existing media file only by skip-heuristics — record it as a scan finding. */
async function recordIngestSkip(
	data: MediaFileIngestData,
	mediaFile: SkippedMediaFile,
	context: ApplicationContext,
	dependencies: MediaFileIngestTaskDependencies,
): Promise<MediaFileIngestResult> {
	await dependencies.upsertScanFinding({
		libraryId: data.libraryId,
		filePath: data.filePath,
		fileName: mediaFile.fileName,
		reason: mediaFile.skipReason,
	});

	context.logger?.warn("Media file not imported — recorded in library scan findings", {
		libraryId: data.libraryId,
		filePath: data.filePath,
		reason: mediaFile.skipReason,
	});

	return {
		libraryId: data.libraryId,
		filePath: data.filePath,
		mediaFileId: null,
		created: false,
		skipReason: mediaFile.skipReason,
	};
}

function correlationIdFor(input: IngestCompletionInput, target: IngestTarget): string {
	return input.context.correlationId ?? input.orchestration.operationId ?? target.mediaFileId;
}

async function saveIngestSidecars(
	target: IngestTarget,
	input: IngestCompletionInput,
	dependencies: MediaFileIngestTaskDependencies,
): Promise<void> {
	await dependencies.saveSidecars(input.library, [
		{
			filePath: input.data.filePath,
			metadataId: target.metadataId,
			movieId: target.movieId,
			episodeId: target.episodeId,
		},
	]);
}

async function emitIngestDiscovered(
	target: IngestTarget,
	input: IngestCompletionInput,
	dependencies: MediaFileIngestTaskDependencies,
): Promise<void> {
	await dependencies.emitMediaDiscovered({
		libraryId: input.data.libraryId,
		mediaFileId: target.mediaFileId,
		correlationId: correlationIdFor(input, target),
	});
}

async function emitIngestIdentified(
	target: IngestTarget,
	input: IngestCompletionInput,
	dependencies: MediaFileIngestTaskDependencies,
): Promise<void> {
	await dependencies.emitMediaIdentified({
		mediaFileId: target.mediaFileId,
		metadataId: target.metadataId,
		status: "matched",
		correlationId: correlationIdFor(input, target),
	});
}

/** Enqueues the follow-up analysis every completed ingest needs; returns its task id. */
async function enqueueCompletionAnalysis(
	target: IngestTarget,
	input: IngestCompletionInput,
	dependencies: MediaFileIngestTaskDependencies,
): Promise<string> {
	const analysisTask = await dependencies.enqueueAnalysis(
		{
			libraryId: input.data.libraryId,
			mediaFileId: target.mediaFileId,
			metadataId: target.metadataId,
		},
		input.taskScheduling,
	);

	return analysisTask.id;
}

function ingestCompletionResult(input: IngestCompletionInput, created: boolean, analysisTaskId: string): MediaFileIngestResult {
	return {
		libraryId: input.data.libraryId,
		filePath: input.data.filePath,
		mediaFileId: input.target.mediaFileId,
		created,
		analysisTaskId,
	};
}

/** Completes the idempotent side effects a crashed prior attempt may have left unfinished. */
async function completeRetryIngest(
	input: IngestCompletionInput,
	dependencies: MediaFileIngestTaskDependencies,
): Promise<MediaFileIngestResult> {
	const progress = dependencies.readIngestProgress ? await dependencies.readIngestProgress(input.target.mediaFileId) : undefined;
	if (progress && !progress.sidecarWritten) {
		await saveIngestSidecars(input.target, input, dependencies);
		await dependencies.markSidecarWritten?.(input.target.mediaFileId);
	}

	if (progress && !progress.discoveredEmitted) {
		await emitIngestDiscovered(input.target, input, dependencies);
		await dependencies.markDiscoveredEmitted?.(input.target.mediaFileId);
	}

	const analysisTaskId = await enqueueCompletionAnalysis(input.target, input, dependencies);

	return ingestCompletionResult(input, false, analysisTaskId);
}

/** First-attempt completion: persist sidecars, emit plugin events, enqueue analysis. */
async function completeFreshIngest(
	input: IngestCompletionInput,
	dependencies: MediaFileIngestTaskDependencies,
): Promise<MediaFileIngestResult> {
	await saveIngestSidecars(input.target, input, dependencies);
	await dependencies.markSidecarWritten?.(input.target.mediaFileId);
	await emitIngestDiscovered(input.target, input, dependencies);
	await dependencies.markDiscoveredEmitted?.(input.target.mediaFileId);
	await emitIngestIdentified(input.target, input, dependencies);
	// File counts/size in the library stats cache changed.
	librariesRepository.clearStatsCache();

	const analysisTaskId = await enqueueCompletionAnalysis(input.target, input, dependencies);

	return ingestCompletionResult(input, true, analysisTaskId);
}

export async function ingestMediaFileTask(
	data: MediaFileIngestData,
	context: ApplicationContext,
	dependencies: MediaFileIngestTaskDependencies = defaultDependencies,
	orchestration: MediaFileIngestOrchestration = {},
): Promise<MediaFileIngestResult> {
	try {
		context.signal?.throwIfAborted();
		const library = await dependencies.findLibrary(data.libraryId);
		assertFound(library, "Library", data.libraryId);

		const taskScheduling = toTaskSchedulingOptions(orchestration);
		const mediaFile = await dependencies.processFile(data.libraryType, data.filePath, true, context.signal, taskScheduling, data.libraryId);
		if (!mediaFile) {
			await dependencies.deleteScanFinding(data.libraryId, data.filePath);

			return { libraryId: data.libraryId, filePath: data.filePath, mediaFileId: null, created: false };
		}

		if ("skipReason" in mediaFile) {
			return await recordIngestSkip(data, mediaFile, context, dependencies);
		}

		await dependencies.deleteScanFinding(data.libraryId, data.filePath);

		// Chapter markers are NOT part of CreateMediaFile — strip before insert.
		const { automaticMarkers, ...createData } = mediaFile;
		const { mediaFile: createdMediaFile, created } = await dependencies.createMediaFile({
			libraryId: data.libraryId,
			...createData,
		});

		const input: IngestCompletionInput = {
			data,
			library,
			target: {
				mediaFileId: createdMediaFile.id,
				metadataId: mediaFile.metadataId,
				movieId: mediaFile.movieId ?? null,
				episodeId: mediaFile.episodeId ?? null,
			},
			context,
			orchestration,
			taskScheduling,
		};

		// A multi-episode file (S01E01-E02) owns one row per covered episode; the
		// main row above is the first episode, the rest are created here. Runs
		// regardless of the main row's created flag so a backfill re-ingest of an
		// older single-episode import still fills in the missing episodes.
		for (const target of mediaFile.additionalTargets ?? []) {
			try {
				const { mediaFile: episodeFile, created: episodeCreated } = await dependencies.createMediaFile({
					libraryId: data.libraryId,
					...createData,
					metadataId: target.metadataId,
					movieId: target.movieId,
					episodeId: target.episodeId,
				});
				if (!episodeCreated) continue;

				if (dependencies.importSidecarSubtitles) {
					await dependencies.importSidecarSubtitles(episodeFile.id, data.filePath);
				}

				if (serverConfig.trickplay.enabled && serverConfig.trickplay.autoOnRefresh) {
					await dependencies.enqueueTrickplayGeneration(episodeFile.id);
				}

				const episodeTarget: IngestTarget = {
					mediaFileId: episodeFile.id,
					metadataId: target.metadataId,
					movieId: target.movieId,
					episodeId: target.episodeId,
				};
				await enqueueCompletionAnalysis(episodeTarget, input, dependencies);
				await saveIngestSidecars(episodeTarget, input, dependencies);
				await emitIngestDiscovered(episodeTarget, input, dependencies);
				await emitIngestIdentified(episodeTarget, input, dependencies);
			} catch (error) {
				// The row count stays below the file's span, so the next scan
				// re-ingests this file and retries the missing episode.
				context.logger?.warn("Multi-episode target ingest failed", {
					filePath: data.filePath,
					episodeId: target.episodeId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Scoped replace touches only `source: "automatic"` rows; manual and
		// plugin markers survive rescans.
		if (automaticMarkers?.length) {
			await mediaMarkersRepository.replaceMarkersForMediaFile(
				createdMediaFile.id,
				automaticMarkers.map(({ type, startSeconds, endSeconds, label }) => ({
					type,
					startSeconds,
					endSeconds,
					...(label !== null ? { label } : {}),
				})),
				{ source: "automatic" },
			);
		}

		if (dependencies.importSidecarSubtitles) {
			await dependencies.importSidecarSubtitles(createdMediaFile.id, data.filePath);
		}

		// Built-in trickplay: generate previews for freshly ingested files.
		if (serverConfig.trickplay.enabled && serverConfig.trickplay.autoOnRefresh) {
			await dependencies.enqueueTrickplayGeneration(createdMediaFile.id);
		}

		if (!created) {
			// A retry can land here when the first attempt created the row but
			// crashed before finishing its post-create side effects.
			if ((orchestration.attempt ?? 1) > 1) return await completeRetryIngest(input, dependencies);

			return { libraryId: data.libraryId, filePath: data.filePath, mediaFileId: createdMediaFile.id, created: false };
		}

		return await completeFreshIngest(input, dependencies);
	} catch (error) {
		throw toDomainError(error, `Media file ingest failed: ${data.filePath}`);
	}
}

// ─── Enqueue Function ─────────────────────────────────────────────────────────

export function enqueueMediaFileIngest(data: MediaFileIngestData, options: WorkerEnqueueOptions = {}) {
	return workerService.addItem(mediaFileIngestWorker.id, data, { ...options, ...mediaFileIngestQueueOptions(data) });
}

function mediaFileIngestQueueOptions(data: MediaFileIngestData) {
	return {
		dedupeKey: `${data.libraryId}:${data.filePath}`,
		reference: { type: "library", id: data.libraryId },
	};
}

/** Batched variant of {@link enqueueMediaFileIngest} — one INSERT batch instead of one INSERT per file. */
export function enqueueManyMediaFileIngest(entries: readonly MediaFileIngestData[], options: WorkerEnqueueOptions = {}) {
	return workerService.addItems(
		mediaFileIngestWorker.id,
		entries.map((data) => ({
			data,
			options: { ...options, ...mediaFileIngestQueueOptions(data) },
		})),
	);
}
