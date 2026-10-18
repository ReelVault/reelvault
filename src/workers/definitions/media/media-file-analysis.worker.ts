import { serverConfig } from "@/config/server/server.config";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { hasEntry } from "@/utils/array.utils";
import { withDomainError } from "@/utils/domain.errors";
import type { ApplicationContext } from "@/utils/task-context.types";
import { workerDependencies } from "@/workers/worker.ports";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

export interface MediaFileAnalysisData {
	libraryId: string;
	mediaFileId: string;
	metadataId: string;
}

export interface MediaFileAnalysisResult {
	mediaFileId: string;
	analyzed: boolean;
}

// ─── Worker Definition ────────────────────────────────────────────────────────

export const mediaFileAnalysisWorker = createWorkerDefinition<MediaFileAnalysisData>(
	"media-file-analysis",
	() => serverConfig.workers.definitions.mediaFileAnalysis,
	async ({ data, logger, signal, operationId, taskId }) =>
		await analyzeMediaFileTask(data, { signal, logger, operationId, correlationId: operationId, taskId }),
);

// ─── Task Function ────────────────────────────────────────────────────────────

export async function analyzeMediaFileTask(
	data: MediaFileAnalysisData,
	context: ApplicationContext = {},
): Promise<MediaFileAnalysisResult> {
	return await withDomainError(`Media file analysis failed: ${data.mediaFileId}`, async () => {
		context.signal?.throwIfAborted();
		const publicMediaFile = await workerDependencies().services.pluginMedia.get(data.mediaFileId);
		let analyzed = false;
		if (publicMediaFile) {
			const analysis = await workerDependencies().services.pluginRegistry.analyzeMedia(publicMediaFile);

			const hasAnalysis = hasEntry(analysis);
			if (hasAnalysis) {
				await workerDependencies().media.update({ primaryId: data.mediaFileId, values: analysis });
				analyzed = true;
			}
		}

		await pluginEventBus.emit("media.file.ready", {
			libraryId: data.libraryId,
			mediaFileId: data.mediaFileId,
			metadataId: data.metadataId,
			correlationId: context.correlationId ?? data.mediaFileId,
		});

		return { mediaFileId: data.mediaFileId, analyzed };
	});
}

// ─── Enqueue Function ─────────────────────────────────────────────────────────

export function enqueueMediaFileAnalysis(data: MediaFileAnalysisData, options: WorkerEnqueueOptions = {}) {
	return workerService.addItem(mediaFileAnalysisWorker.id, data, {
		...options,
		dedupeKey: data.mediaFileId,
		reference: { type: "media-file", id: data.mediaFileId },
	});
}
