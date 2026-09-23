import type { CreateMediaFile, LibraryWithRelations } from "@reelvault/sdk/common";
import type { PluginEventInput } from "@reelvault/sdk/plugin";
import { type ApplicationContext, type TaskSchedulingOptions, toDomainError } from "@/application/context";
import { pluginsService } from "@/application/plugins.service";
import { librariesRepository } from "@/database/repositories/libraries.repository";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { mediaMarkersRepository } from "@/database/repositories/media-markers.repository";
import { scanFindingsRepository } from "@/database/repositories/scan-findings.repository";
import { SidecarMetadataStorageService } from "@/modules/metadata-sidecars/sidecar-metadata-storage.service";
import { sidecarMetadataWriter } from "@/modules/metadata-sidecars/sidecar-metadata-writer.runtime";
import { mediaFileProcessor } from "@/modules/scanner/processing/media-file-processor";
import type { ProcessedMediaFileWithMarkers, ScanFindingReason, SkippedMediaFile } from "@/modules/scanner/scanner.types";
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
	): Promise<ProcessedMediaFileWithMarkers | SkippedMediaFile | null>;
	upsertScanFinding(finding: { libraryId: string; filePath: string; fileName: string; reason: ScanFindingReason }): Promise<void>;
	deleteScanFinding(libraryId: string, filePath: string): Promise<void>;
	createMediaFile(data: CreateMediaFile): Promise<{ mediaFile: { id: string }; created: boolean }>;
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
	processFile: (libraryType, filePath, skipExistingLookup, signal, scheduling) =>
		mediaFileProcessor.process(libraryType, filePath, skipExistingLookup, signal, scheduling),
	upsertScanFinding: (finding) => scanFindingsRepository.upsert(finding),
	deleteScanFinding: (libraryId, filePath) => scanFindingsRepository.remove(libraryId, filePath),
	createMediaFile: (data) => mediaRepository.createWithStreams(data),
	findMediaByPaths: (libraryId, filePaths) => mediaRepository.findByLibraryAndPaths({ libraryId, filePaths }),
	saveSidecars: (library, mediaFiles) => new SidecarMetadataStorageService(sidecarMetadataWriter).saveLibraryMedia(library, mediaFiles),
	emitMediaDiscovered: (input) => pluginsService.emit("media.file.discovered", input),
	emitMediaIdentified: (input) => pluginsService.emit("media.file.identified", input),
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
		const mediaFile = await dependencies.processFile(data.libraryType, data.filePath, true, context.signal, taskScheduling);
		if (!mediaFile) {
			await dependencies.deleteScanFinding(data.libraryId, data.filePath);

			return { libraryId: data.libraryId, filePath: data.filePath, mediaFileId: null, created: false };
		}

		if ("skipReason" in mediaFile) {
			await dependencies.upsertScanFinding({
				libraryId: data.libraryId,
				filePath: data.filePath,
				fileName: mediaFile.fileName,
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

		await dependencies.deleteScanFinding(data.libraryId, data.filePath);

		// Chapter markers are NOT part of CreateMediaFile — strip before insert.
		const { automaticMarkers, ...createData } = mediaFile;
		const { mediaFile: createdMediaFile, created } = await dependencies.createMediaFile({
			libraryId: data.libraryId,
			...createData,
		});

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

		// Built-in trickplay: generate previews for freshly ingested files.
		if (serverConfig.trickplay.enabled && serverConfig.trickplay.autoOnRefresh) {
			await dependencies.enqueueTrickplayGeneration(createdMediaFile.id);
		}

		if (!created) {
			// A retry can land here when the first attempt created the row but
			// crashed before finishing its post-create side effects. Complete the
			// missing, idempotent ones — a normal rescan (attempt 1) must not.
			if ((orchestration.attempt ?? 1) > 1) {
				const progress = dependencies.readIngestProgress ? await dependencies.readIngestProgress(createdMediaFile.id) : undefined;
				if (progress && !progress.sidecarWritten) {
					await dependencies.saveSidecars(library, [
						{
							filePath: data.filePath,
							metadataId: mediaFile.metadataId,
							movieId: mediaFile.movieId ?? null,
							episodeId: mediaFile.episodeId ?? null,
						},
					]);
					await dependencies.markSidecarWritten?.(createdMediaFile.id);
				}

				if (progress && !progress.discoveredEmitted) {
					await dependencies.emitMediaDiscovered({
						libraryId: data.libraryId,
						mediaFileId: createdMediaFile.id,
						correlationId: context.correlationId ?? orchestration.operationId ?? createdMediaFile.id,
					});
					await dependencies.markDiscoveredEmitted?.(createdMediaFile.id);
				}

				const retryAnalysis = await dependencies.enqueueAnalysis(
					{
						libraryId: data.libraryId,
						mediaFileId: createdMediaFile.id,
						metadataId: mediaFile.metadataId,
					},
					taskScheduling,
				);

				return {
					libraryId: data.libraryId,
					filePath: data.filePath,
					mediaFileId: createdMediaFile.id,
					created: false,
					analysisTaskId: retryAnalysis.id,
				};
			}

			return { libraryId: data.libraryId, filePath: data.filePath, mediaFileId: createdMediaFile.id, created: false };
		}

		await dependencies.saveSidecars(library, [
			{
				filePath: data.filePath,
				metadataId: mediaFile.metadataId,
				movieId: mediaFile.movieId ?? null,
				episodeId: mediaFile.episodeId ?? null,
			},
		]);
		await dependencies.markSidecarWritten?.(createdMediaFile.id);
		await dependencies.emitMediaDiscovered({
			libraryId: data.libraryId,
			mediaFileId: createdMediaFile.id,
			correlationId: context.correlationId ?? orchestration.operationId ?? createdMediaFile.id,
		});
		await dependencies.markDiscoveredEmitted?.(createdMediaFile.id);
		await dependencies.emitMediaIdentified({
			mediaFileId: createdMediaFile.id,
			metadataId: mediaFile.metadataId,
			status: "matched",
			correlationId: context.correlationId ?? orchestration.operationId ?? createdMediaFile.id,
		});
		// File counts/size in the library stats cache changed.
		librariesRepository.clearStatsCache();

		const analysisTask = await dependencies.enqueueAnalysis(
			{
				libraryId: data.libraryId,
				mediaFileId: createdMediaFile.id,
				metadataId: mediaFile.metadataId,
			},
			taskScheduling,
		);

		return {
			libraryId: data.libraryId,
			filePath: data.filePath,
			mediaFileId: createdMediaFile.id,
			created: true,
			analysisTaskId: analysisTask.id,
		};
	} catch (error) {
		throw toDomainError(error, `Media file ingest failed: ${data.filePath}`);
	}
}

// ─── Enqueue Function ─────────────────────────────────────────────────────────

export function enqueueMediaFileIngest(data: MediaFileIngestData, options: WorkerEnqueueOptions = {}) {
	return workerService.addItem(mediaFileIngestWorker.id, data, {
		...options,
		dedupeKey: `${data.libraryId}:${data.filePath}`,
		reference: { type: "library", id: data.libraryId },
	});
}

/** Batched variant of {@link enqueueMediaFileIngest} — one INSERT batch instead of one INSERT per file. */
export function enqueueManyMediaFileIngest(entries: readonly MediaFileIngestData[], options: WorkerEnqueueOptions = {}) {
	return workerService.addItems(
		mediaFileIngestWorker.id,
		entries.map((data) => ({
			data,
			options: {
				...options,
				dedupeKey: `${data.libraryId}:${data.filePath}`,
				reference: { type: "library", id: data.libraryId },
			},
		})),
	);
}
