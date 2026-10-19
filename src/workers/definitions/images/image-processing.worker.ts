import { serverConfig } from "@/config/server/server.config";
import { imageProcessingService } from "@/modules/images/image-processing.service";
import { DomainError, toDomainError } from "@/utils/domain.errors";
import type { ApplicationContext } from "@/utils/task-context.types";
import { defineWorkerEnqueue } from "@/workers/utils/worker-enqueue.utils";
import { createWorkerDefinition } from "@/workers/worker.types";

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
				throw new DomainError("validation", "Unknown image processing kind", { code: "images.processing_kind_unknown" });
		}
	} catch (error) {
		throw toDomainError(error, `Image processing failed: ${data.kind}`);
	}
}

// ─── Enqueue Function ─────────────────────────────────────────────────────────

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
			throw new DomainError("validation", "Unknown image processing kind", { code: "images.processing_kind_unknown" });
	}
}

const imageProcessingEnqueue = defineWorkerEnqueue<ImageProcessingData>(imageProcessingWorker.id, (data) => {
	const { kind, id } = getEntityInfo(data);
	const priorities = serverConfig.workers.definitions.imageProcessing.priorities;

	return {
		dedupeKey: `image-processing_${kind}:${id}`,
		reference: { type: kind, id },
		priority: priorities[kind],
	};
});

export const enqueueImageProcessing = imageProcessingEnqueue.enqueue;
