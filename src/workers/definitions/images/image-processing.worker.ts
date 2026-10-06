import { type ApplicationContext, toDomainError } from "@/application/context";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { serverConfig } from "@/server.config";
import { ValidationError } from "@/utils/errors";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ImageProcessInput {
	url?: string | undefined;
	type: "poster" | "backdrop";
}

export type ImageProcessingData =
	| { kind: "metadata"; metadataId: string; urls: ImageProcessInput[] }
	| { kind: "person"; personId: string; urls: string }
	| { kind: "season"; metadataId: string; seasonId: string; seasonNumber: string; urls: string }
	| { kind: "episode"; metadataId: string; episodeId: string; seasonNumber: string; episodeNumber: string; urls: string };

export interface ImageProcessingResult {
	entityType: ImageProcessingData["kind"];
	entityId: string;
}

// ─── Worker Definition ────────────────────────────────────────────────────────

export const imageProcessingWorker = createWorkerDefinition<ImageProcessingData>(
	"image-processing",
	() => serverConfig.workers.definitions.imageProcessing,
	async ({ data, logger, signal, operationId, taskId }) =>
		await processImageTask(data, { signal, logger, operationId, correlationId: operationId, taskId }),
);

// ─── Task Function ────────────────────────────────────────────────────────────

export async function processImageTask(data: ImageProcessingData, context: ApplicationContext = {}): Promise<ImageProcessingResult> {
	try {
		context.signal?.throwIfAborted();
		switch (data.kind) {
			case "metadata":
				await imageProcessingService.processMetadata(data.metadataId, data.urls, false, context.signal);

				return { entityType: data.kind, entityId: data.metadataId };
			case "person":
				await imageProcessingService.processPerson(data.personId, data.urls, false, context.signal);

				return { entityType: data.kind, entityId: data.personId };
			case "season":
				await imageProcessingService.processSeason(
					{
						metadataId: data.metadataId,
						seasonId: data.seasonId,
						imagesUrl: data.urls,
					},
					context.signal,
				);

				return { entityType: data.kind, entityId: data.seasonId };
			case "episode":
				await imageProcessingService.processEpisode(
					{
						metadataId: data.metadataId,
						episodeId: data.episodeId,
						imagesUrl: data.urls,
					},
					context.signal,
				);

				return { entityType: data.kind, entityId: data.episodeId };
			default:
				throw new ValidationError("Unknown image processing kind");
		}
	} catch (error) {
		throw toDomainError(error, `Image processing failed: ${data.kind}`);
	}
}

// ─── Enqueue Function ─────────────────────────────────────────────────────────

export function enqueueImageProcessing(data: ImageProcessingData, options: WorkerEnqueueOptions = {}) {
	return workerService.addItem(imageProcessingWorker.id, data, { ...options, ...imageProcessingQueueOptions(data) });
}

function getEntityInfo(data: ImageProcessingData): { kind: ImageProcessingData["kind"]; id: string } {
	switch (data.kind) {
		case "metadata":
			return { kind: "metadata", id: data.metadataId };
		case "person":
			return { kind: "person", id: data.personId };
		case "season":
			return { kind: "season", id: data.seasonId };
		case "episode":
			return { kind: "episode", id: data.episodeId };
		default:
			throw new ValidationError("Unknown image processing kind");
	}
}

function imageProcessingQueueOptions(data: ImageProcessingData) {
	const { kind, id } = getEntityInfo(data);
	const priorities = serverConfig.workers.definitions.imageProcessing.priorities;

	return {
		dedupeKey: `image-processing_${kind}:${id}`,
		reference: { type: kind, id },
		priority: priorities[kind],
	};
}
