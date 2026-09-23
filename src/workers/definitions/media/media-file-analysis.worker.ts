import type { PluginMediaFile } from "@reelvault/sdk/common";
import type { MediaAnalysis, PluginEventInput } from "@reelvault/sdk/plugin";
import { type ApplicationContext, withDomainError } from "@/application/context";
import { pluginsService } from "@/application/plugins.service";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { serverConfig } from "@/server.config";
import { hasEntry } from "@/utils/array.utils";
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

export interface MediaFileAnalysisTaskDependencies {
	getPublicMedia(mediaFileId: string): Promise<PluginMediaFile | null>;
	analyzeMedia(media: PluginMediaFile): Promise<MediaAnalysis>;
	updateMediaFile(mediaFileId: string, values: MediaAnalysis): Promise<void>;
	emitMediaReady(input: PluginEventInput<"media.file.ready">): Promise<void>;
}

const defaultDependencies: MediaFileAnalysisTaskDependencies = {
	getPublicMedia: (mediaFileId) => pluginsService.getPublicMedia(mediaFileId),
	analyzeMedia: (media) => pluginsService.analyzeMedia(media),
	updateMediaFile: (mediaFileId, values) => mediaRepository.update({ primaryId: mediaFileId, values }),
	emitMediaReady: (input) => pluginsService.emit("media.file.ready", input),
};

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
	dependencies: MediaFileAnalysisTaskDependencies = defaultDependencies,
): Promise<MediaFileAnalysisResult> {
	return await withDomainError(`Media file analysis failed: ${data.mediaFileId}`, async () => {
		context.signal?.throwIfAborted();
		const publicMediaFile = await dependencies.getPublicMedia(data.mediaFileId);
		let analyzed = false;
		if (publicMediaFile) {
			const analysis = await dependencies.analyzeMedia(publicMediaFile);

			const hasAnalysis = hasEntry(analysis);
			if (hasAnalysis) {
				await dependencies.updateMediaFile(data.mediaFileId, analysis);
				analyzed = true;
			}
		}

		await dependencies.emitMediaReady({
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
