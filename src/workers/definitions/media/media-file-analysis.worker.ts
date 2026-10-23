import type { UpdateMediaFile } from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";
import { pluginMediaService } from "@/plugins/capabilities/plugin.media";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { mediaRepository } from "@/repositories/media-files.repository";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { hasEntry } from "@/utils/array.utils";
import { withDomainError } from "@/utils/domain.errors";
import type { ApplicationContext } from "@/utils/task-context.types";
import { toApplicationContext } from "@/workers/utils/task-context.mapper";
import { defineWorkerEnqueue } from "@/workers/utils/worker-enqueue.utils";
import { createWorkerDefinition } from "@/workers/worker.types";

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
	async (context) => await analyzeMediaFileTask(context.data, toApplicationContext(context)),
);

// ─── Task Function ────────────────────────────────────────────────────────────

export async function analyzeMediaFileTask(
	data: MediaFileAnalysisData,
	context: ApplicationContext = {},
): Promise<MediaFileAnalysisResult> {
	return await withDomainError(`Media file analysis failed: ${data.mediaFileId}`, async () => {
		context.signal?.throwIfAborted();
		const publicMediaFile = await pluginMediaService.get(data.mediaFileId);
		let analyzed = false;
		if (publicMediaFile) {
			const analysis = await pluginRegistry.analyzeMedia(publicMediaFile);

			const hasAnalysis = hasEntry(analysis);
			if (hasAnalysis) {
				const values: UpdateMediaFile = {};
				if (analysis.source !== undefined) values.source = analysis.source;
				if (analysis.edition !== undefined) values.edition = analysis.edition;
				if (analysis.qualityTag !== undefined) values.qualityTag = analysis.qualityTag;
				await mediaRepository.updateAndRead(data.mediaFileId, values);
				analyzed = true;
			}
		}

		pluginEventBus.publish("media.file.ready", {
			libraryId: data.libraryId,
			mediaFileId: data.mediaFileId,
			metadataId: data.metadataId,
			correlationId: context.correlationId ?? data.mediaFileId,
		});

		return { mediaFileId: data.mediaFileId, analyzed };
	});
}

// ─── Enqueue Function ─────────────────────────────────────────────────────────

const mediaFileAnalysisEnqueue = defineWorkerEnqueue<MediaFileAnalysisData>(mediaFileAnalysisWorker.id, (data) => ({
	dedupeKey: data.mediaFileId,
	reference: { type: "media-file", id: data.mediaFileId },
}));

export const enqueueMediaFileAnalysis = mediaFileAnalysisEnqueue.enqueue;
