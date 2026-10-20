import { serverConfig } from "@/config/server/server.config";
import { mapChaptersToMarkers } from "@/modules/scanner/probe/chapters-to-markers.utils";
import { mapMediaFileData } from "@/modules/scanner/probe/media-probe.mapper";
import { videoParser } from "@/modules/scanner/probe/video-parser.service";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { assertFound, toDomainError } from "@/utils/domain.errors";
import { getFileStats } from "@/utils/file.utils";
import { getFileName } from "@/utils/path.utils";
import type { ApplicationContext } from "@/utils/task-context.types";
import { enqueueTrickplayGenerationForLibrary } from "@/workers/definitions/media/trickplay-generate.worker";
import { toApplicationContext } from "@/workers/utils/task-context.mapper";
import { defineWorkerEnqueue } from "@/workers/utils/worker-enqueue.utils";
import { workerDependencies } from "@/workers/worker.ports";
import { createWorkerDefinition, type WorkerEnqueueOptions } from "@/workers/worker.types";

// ─── Worker Definition ────────────────────────────────────────────────────────

export const mediaFileTechnicalRefreshWorker = createWorkerDefinition<{ mediaFileId: string }>(
	"media-file-technical-refresh",
	() => serverConfig.workers.definitions.mediaFileTechnicalRefresh,
	async (context) => await refreshMediaFileTechnicalData(context.data.mediaFileId, toApplicationContext(context)),
);

// ─── Task Function ────────────────────────────────────────────────────────────

async function refreshMediaFileTechnicalData(mediaFileId: string, context: ApplicationContext = {}) {
	try {
		context.signal?.throwIfAborted();
		const mediaFile = await workerDependencies().media.findForTechnicalRefresh(mediaFileId);
		assertFound(mediaFile, "MediaFile", mediaFileId);

		const [probe, stats] = await Promise.all([videoParser.probe(mediaFile.filePath, context.signal), getFileStats(mediaFile.filePath)]);
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

		const data = mapMediaFileData(getFileName(mediaFile.filePath), probe);
		const sourceMtimeMs = Math.floor(stats.mtimeMs);
		const previousAudioKeys = mediaFile.audioStreams.map((s) => `${s.index}:${s.codecName}:${s.language ?? ""}`).join("|");
		const newAudioKeys = data.audioStreams.map((s) => `${s.index}:${s.codecName}:${s.language ?? ""}`).join("|");
		const audioChanged = previousAudioKeys !== newAudioKeys;

		await workerDependencies().media.replaceTechnicalData({
			mediaFileId,
			data,
			size: stats.size,
			sourceMtimeMs,
		});

		// Chapter-derived intro/credits/recap markers. Scoped replace touches only
		// `source: "automatic"` rows — manual and plugin markers are never touched,
		// and chapters disappearing from the file clears the automatic set.
		await workerDependencies().mediaMarkers.replaceMarkersForMediaFile(
			mediaFileId,
			mapChaptersToMarkers(probe.chapters ?? []).map((marker) => ({
				type: marker.type,
				startSeconds: marker.startSeconds,
				endSeconds: marker.endSeconds,
				...(marker.label === null ? {} : { label: marker.label }),
			})),
			{ source: "automatic" },
		);

		// Built-in trickplay: regenerate previews after the technical revision changed.
		if (serverConfig.trickplay.enabled && serverConfig.trickplay.autoOnRefresh) {
			await enqueueTrickplayGenerationForLibrary(mediaFileId, mediaFile.libraryId);
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

const mediaFileTechnicalRefreshEnqueue = defineWorkerEnqueue<{ mediaFileId: string }>(mediaFileTechnicalRefreshWorker.id, (data) => ({
	dedupeKey: data.mediaFileId,
	reference: { type: "media-file", id: data.mediaFileId },
}));

export async function enqueueMediaFileTechnicalRefresh(mediaFileId: string, options: WorkerEnqueueOptions = {}) {
	return await mediaFileTechnicalRefreshEnqueue.enqueue({ mediaFileId }, options);
}
