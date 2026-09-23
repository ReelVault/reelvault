import { type ApplicationContext, toDomainError } from "@/application/context";
import { mediaRepository } from "@/database/repositories/media-files.repository";
import { mediaMarkersRepository } from "@/database/repositories/media-markers.repository";
import { mapChaptersToMarkers } from "@/modules/scanner/probe/chapters-to-markers.utils";
import { mapMediaFileData } from "@/modules/scanner/probe/media-probe.mapper";
import { videoParser } from "@/modules/scanner/probe/video-parser.service";
import { pluginEventBus } from "@/plugins/runtime/plugin.events";
import { serverConfig } from "@/server.config";
import { assertFound } from "@/utils/errors";
import { FileUtils } from "@/utils/file.utils";
import { PathUtils } from "@/utils/path.utils";
import { enqueueTrickplayGeneration } from "@/workers/definitions/media/trickplay-generate.worker";
import { workerService } from "@/workers/worker.service";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

// ─── Worker Definition ────────────────────────────────────────────────────────

export const mediaFileTechnicalRefreshWorker = createWorkerDefinition<{ mediaFileId: string }>(
	"media-file-technical-refresh",
	() => serverConfig.workers.definitions.mediaFileTechnicalRefresh,
	async ({ data, logger, signal, operationId, taskId }) =>
		await refreshMediaFileTechnicalData(data.mediaFileId, { signal, logger, operationId, correlationId: operationId, taskId }),
);

// ─── Task Function ────────────────────────────────────────────────────────────

async function refreshMediaFileTechnicalData(mediaFileId: string, context: ApplicationContext = {}) {
	try {
		context.signal?.throwIfAborted();
		const mediaFile = await mediaRepository.findForTechnicalRefresh(mediaFileId);
		assertFound(mediaFile, "MediaFile", mediaFileId);

		const [probe, stats] = await Promise.all([
			videoParser.probe(mediaFile.filePath, context.signal),
			FileUtils.getStats(mediaFile.filePath),
		]);
		// A failed probe (corrupt file) or a file that vanished between enqueue and
		// run is an expected anomaly — keep the existing technical data instead of
		// failing the job; the scanner's removal detection owns deletions.
		if (!(probe && stats?.isFile())) {
			context.logger?.warn("Technical refresh skipped — source unreadable, keeping existing technical data", {
				mediaFileId,
				filePath: mediaFile.filePath,
				probeSucceeded: probe !== null,
				fileExists: stats?.isFile() === true,
			});

			return { mediaFileId, skipped: true as const };
		}

		const data = mapMediaFileData(PathUtils.getFileName(mediaFile.filePath), probe);
		const sourceMtimeMs = Math.floor(stats.mtimeMs);
		const prevAudioKeys = mediaFile.audioStreams.map((s) => `${s.index}:${s.codecName}:${s.language ?? ""}`).join("|");
		const newAudioKeys = data.audioStreams.map((s) => `${s.index}:${s.codecName}:${s.language ?? ""}`).join("|");
		const audioChanged = prevAudioKeys !== newAudioKeys;

		await mediaRepository.replaceTechnicalData({
			mediaFileId,
			data,
			size: stats.size,
			sourceMtimeMs,
		});

		// Chapter-derived intro/credits/recap markers. Scoped replace touches only
		// `source: "automatic"` rows — manual and plugin markers are never touched,
		// and chapters disappearing from the file clears the automatic set.
		await mediaMarkersRepository.replaceMarkersForMediaFile(
			mediaFileId,
			mapChaptersToMarkers(probe.chapters ?? []).map((marker) => ({
				type: marker.type,
				startSeconds: marker.startSeconds,
				endSeconds: marker.endSeconds,
				...(marker.label !== null ? { label: marker.label } : {}),
			})),
			{ source: "automatic" },
		);

		// Built-in trickplay: regenerate previews after the technical revision changed.
		if (serverConfig.trickplay.enabled && serverConfig.trickplay.autoOnRefresh) {
			await enqueueTrickplayGeneration(mediaFileId);
		}

		// Plugins deriving data from the source file (analysis caches, thumbnails)
		// key their freshness on (size, mtime) — tell them the revision changed.
		pluginEventBus.publish("media.file.technical-data-updated", {
			mediaFileId,
			size: stats.size,
			sourceMtimeMs,
			audioChanged,
		});

		return {
			mediaFileId,
			videoStreams: data.videoStreams.length,
			audioStreams: data.audioStreams.length,
			subtitles: data.subtitles?.length ?? 0,
		};
	} catch (error) {
		throw toDomainError(error, `Media file technical refresh failed: ${mediaFileId}`);
	}
}

// ─── Enqueue Function ─────────────────────────────────────────────────────────

export async function enqueueMediaFileTechnicalRefresh(mediaFileId: string, options: WorkerEnqueueOptions = {}) {
	return await workerService.addItem(
		mediaFileTechnicalRefreshWorker.id,
		{ mediaFileId },
		{
			...options,
			dedupeKey: mediaFileId,
			reference: { type: "media-file", id: mediaFileId },
		},
	);
}
