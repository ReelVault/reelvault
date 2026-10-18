import type { CreateMediaFile } from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";
import { workerDependencies } from "@/workers/worker.ports";
import type {
	IngestCompletionInput,
	IngestTarget,
	MediaFileIngestResult,
	MediaFileIngestTaskDependencies,
} from "./media-file-ingest.types";

type Deps = MediaFileIngestTaskDependencies;

export async function importIngestSubtitles(mediaFileId: string, filePath: string, dependencies: Deps): Promise<void> {
	if (dependencies.importSidecarSubtitles) {
		await dependencies.importSidecarSubtitles(mediaFileId, filePath);
	}
}

export async function enqueueTrickplayIfEnabled(mediaFileId: string, libraryId: string, dependencies: Deps): Promise<void> {
	if (serverConfig.trickplay.enabled && serverConfig.trickplay.autoOnRefresh) {
		await dependencies.enqueueTrickplayGeneration(mediaFileId, libraryId);
	}
}

function correlationIdFor(input: IngestCompletionInput, target: IngestTarget): string {
	return input.context.correlationId ?? input.orchestration.operationId ?? target.mediaFileId;
}

async function saveIngestSidecars(target: IngestTarget, input: IngestCompletionInput, dependencies: Deps): Promise<void> {
	await dependencies.saveSidecars(input.library, [
		{
			filePath: input.data.filePath,
			metadataId: target.metadataId,
			movieId: target.movieId,
			episodeId: target.episodeId,
		},
	]);
}

async function emitIngestDiscovered(target: IngestTarget, input: IngestCompletionInput, dependencies: Deps): Promise<void> {
	await dependencies.emitMediaDiscovered({
		libraryId: input.data.libraryId,
		mediaFileId: target.mediaFileId,
		correlationId: correlationIdFor(input, target),
	});
}

async function emitIngestIdentified(target: IngestTarget, input: IngestCompletionInput, dependencies: Deps): Promise<void> {
	await dependencies.emitMediaIdentified({
		mediaFileId: target.mediaFileId,
		metadataId: target.metadataId,
		status: "matched",
		correlationId: correlationIdFor(input, target),
	});
}

/** Enqueues the follow-up analysis every completed ingest needs; returns its task id. */
async function enqueueCompletionAnalysis(target: IngestTarget, input: IngestCompletionInput, dependencies: Deps): Promise<string> {
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

/** Reruns only the post-create side effects a crashed prior attempt may have left unfinished. */
async function repairIngestSideEffects(target: IngestTarget, input: IngestCompletionInput, dependencies: Deps): Promise<void> {
	const progress = dependencies.readIngestProgress ? await dependencies.readIngestProgress(target.mediaFileId) : undefined;
	// No progress row means the crashed attempt never reached the marking step —
	// the side effects still need to run.
	if (!progress?.sidecarWritten) {
		await saveIngestSidecars(target, input, dependencies);
		await dependencies.markSidecarWritten?.(target.mediaFileId);
	}

	if (!progress?.discoveredEmitted) {
		await emitIngestDiscovered(target, input, dependencies);
		await dependencies.markDiscoveredEmitted?.(target.mediaFileId);
	}
}

/** Repairs a retried target, then enqueues its analysis. Deduped by media file, so re-running after a crash is safe. */
async function completeRetryTarget(target: IngestTarget, input: IngestCompletionInput, dependencies: Deps): Promise<string> {
	await repairIngestSideEffects(target, input, dependencies);

	return await enqueueCompletionAnalysis(target, input, dependencies);
}

/** The side effects a first-time ingest publishes: sidecar, discovered and identified events. */
async function publishFreshIngest(target: IngestTarget, input: IngestCompletionInput, dependencies: Deps): Promise<void> {
	await saveIngestSidecars(target, input, dependencies);
	await dependencies.markSidecarWritten?.(target.mediaFileId);
	await emitIngestDiscovered(target, input, dependencies);
	await dependencies.markDiscoveredEmitted?.(target.mediaFileId);
	await emitIngestIdentified(target, input, dependencies);
}

/** Retry completion: a crashed prior attempt may have left side effects unfinished. */
export async function completeRetryIngest(input: IngestCompletionInput, dependencies: Deps): Promise<MediaFileIngestResult> {
	const analysisTaskId = await completeRetryTarget(input.target, input, dependencies);

	return ingestCompletionResult(input, false, analysisTaskId);
}

/** First-attempt completion: persist sidecars, emit plugin events, enqueue analysis. */
export async function completeFreshIngest(input: IngestCompletionInput, dependencies: Deps): Promise<MediaFileIngestResult> {
	await publishFreshIngest(input.target, input, dependencies);
	// File counts/size in the library stats cache changed.
	workerDependencies().libraries.clearStatsCache();

	const analysisTaskId = await enqueueCompletionAnalysis(input.target, input, dependencies);

	return ingestCompletionResult(input, true, analysisTaskId);
}

/** Post-create side effects every additional target row needs on a first ingest. */
async function completeAdditionalTarget(target: IngestTarget, input: IngestCompletionInput, dependencies: Deps): Promise<void> {
	await importIngestSubtitles(target.mediaFileId, input.data.filePath, dependencies);
	await enqueueTrickplayIfEnabled(target.mediaFileId, input.data.libraryId, dependencies);
	await enqueueCompletionAnalysis(target, input, dependencies);
	await publishFreshIngest(target, input, dependencies);
}

/** Creates the extra rows of a multi-episode file; a new row is completed, an existing one is repaired on a retry. */
export async function ingestAdditionalTargets(
	targets: ReadonlyArray<Omit<IngestTarget, "mediaFileId">>,
	createData: Omit<CreateMediaFile, "libraryId">,
	input: IngestCompletionInput,
	dependencies: Deps,
): Promise<void> {
	const { data, context, orchestration } = input;

	for (const target of targets) {
		try {
			const { mediaFile: episodeFile, created: episodeCreated } = await dependencies.createMediaFile({
				libraryId: data.libraryId,
				...createData,
				metadataId: target.metadataId,
				movieId: target.movieId,
				episodeId: target.episodeId,
			});

			const episodeTarget: IngestTarget = {
				mediaFileId: episodeFile.id,
				metadataId: target.metadataId,
				movieId: target.movieId,
				episodeId: target.episodeId,
			};

			if (episodeCreated) {
				await completeAdditionalTarget(episodeTarget, input, dependencies);
			} else if ((orchestration.attempt ?? 1) > 1) {
				// The row exists but a crashed prior attempt may not have finished
				// its side effects — the scan re-ingests range files until the span
				// is filled, so this repair must run instead of skipping forever.
				await completeRetryTarget(episodeTarget, input, dependencies);
			}
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
}
