import { serverConfig } from "@/config/server/server.config";
import type { SkippedMediaFile } from "@/modules/scanner/scanner.types";
import { assertFound, toDomainError } from "@/utils/domain.errors";
import { CATALOG_LIST_PATH_PREFIXES, invalidateResponseBodiesForPathPrefixes } from "@/utils/response-body.cache";
import type { ApplicationContext } from "@/utils/task-context.types";
import { toTaskSchedulingOptions } from "@/workers/utils/task-scheduling.mapper";
import { workerDependencies } from "@/workers/worker.ports";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";
import {
	completeFreshIngest,
	completeRetryIngest,
	enqueueTrickplayIfEnabled,
	importIngestSubtitles,
	ingestAdditionalTargets,
} from "./media-file-ingest/completion.utils";
import { defaultDependencies } from "./media-file-ingest/dependencies.utils";
import type {
	IngestCompletionInput,
	MediaFileIngestData,
	MediaFileIngestOrchestration,
	MediaFileIngestResult,
	MediaFileIngestTaskDependencies,
} from "./media-file-ingest/media-file-ingest.types";

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
		const mediaFile = await dependencies.processFile(data.libraryType, data.filePath, true, {
			signal: context.signal,
			scheduling: taskScheduling,
			libraryId: data.libraryId,
		});
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

		if (created) {
			// A new title must not stay hidden behind a cached catalog list until its
			// TTL expires (metadata lists are cached for up to a minute).
			invalidateResponseBodiesForPathPrefixes(CATALOG_LIST_PATH_PREFIXES);
		}

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
		await ingestAdditionalTargets(mediaFile.additionalTargets ?? [], createData, input, dependencies);

		// Scoped replace touches only `source: "automatic"` rows; manual and
		// plugin markers survive rescans.
		if (automaticMarkers?.length) {
			await workerDependencies().mediaMarkers.replaceMarkersForMediaFile(
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

		await importIngestSubtitles(createdMediaFile.id, data.filePath, dependencies);
		// Built-in trickplay: generate previews for freshly ingested files.
		await enqueueTrickplayIfEnabled(createdMediaFile.id, data.libraryId, dependencies);

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
