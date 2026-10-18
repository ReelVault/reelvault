import type { LibraryWithRelations } from "@reelvault/sdk/common";
import { SidecarMetadataStorageService } from "@/modules/metadata-sidecars/sidecar-metadata-storage.service";
import { sidecarMetadataWriter } from "@/modules/metadata-sidecars/sidecar-metadata-writer.runtime";
import { createMediaFileProcessor } from "@/modules/scanner/processing/media-file.processor";
import { importSidecarSubtitles } from "@/modules/scanner/processing/sidecar-subtitles.utils";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { MemoryCache } from "@/utils/memory.cache";
import { enqueueMediaFileAnalysis } from "@/workers/definitions/media/media-file-analysis.worker";
import { enqueueTrickplayGenerationForLibrary } from "@/workers/definitions/media/trickplay-generate.worker";
import { workerDependencies } from "@/workers/worker.ports";
import type { MediaFileIngestTaskDependencies } from "./media-file-ingest.types";

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

let mediaFileProcessor: ReturnType<typeof createMediaFileProcessor> | undefined;

/** Built on first use: `MetadataProcess` sits in an import cycle, so it cannot be constructed at module scope. */
function getMediaFileProcessor(): ReturnType<typeof createMediaFileProcessor> {
	mediaFileProcessor ??= createMediaFileProcessor(workerDependencies().services.metadataProcess);

	return mediaFileProcessor;
}

export const defaultDependencies: MediaFileIngestTaskDependencies = {
	findLibrary: async (libraryId) => {
		const cached = ingestLibraryCache.get(libraryId);
		if (cached) return cached;

		const library = await workerDependencies().libraries.findWithPaths(libraryId);
		if (library) ingestLibraryCache.set(libraryId, library);

		return library;
	},
	processFile: (libraryType, filePath, skipExistingLookup, options) =>
		getMediaFileProcessor().process(libraryType, filePath, skipExistingLookup, options),
	upsertScanFinding: (finding) => workerDependencies().scanFindings.upsert(finding),
	deleteScanFinding: (libraryId, filePath) => workerDependencies().scanFindings.remove(libraryId, filePath),
	createMediaFile: (data) => workerDependencies().media.createWithStreams(data),
	importSidecarSubtitles: (mediaFileId, videoFilePath) => importSidecarSubtitles(mediaFileId, videoFilePath),
	findMediaByPaths: (libraryId, filePaths) => workerDependencies().media.findByLibraryAndPaths({ libraryId, filePaths }),
	saveSidecars: (library, mediaFiles) => new SidecarMetadataStorageService(sidecarMetadataWriter).saveLibraryMedia(library, mediaFiles),
	emitMediaDiscovered: (input) => pluginEventBus.emit("media.file.discovered", input),
	emitMediaIdentified: (input) => pluginEventBus.emit("media.file.identified", input),
	readIngestProgress: (mediaFileId) => workerDependencies().media.findIngestProgress(mediaFileId),
	markSidecarWritten: (mediaFileId) => workerDependencies().media.markIngestSidecarWritten(mediaFileId),
	markDiscoveredEmitted: (mediaFileId) => workerDependencies().media.markIngestDiscoveredEmitted(mediaFileId),
	enqueueTrickplayGeneration: (mediaFileId, libraryId) => enqueueTrickplayGenerationForLibrary(mediaFileId, libraryId),
	enqueueAnalysis: (data, options) => enqueueMediaFileAnalysis(data, options ?? {}),
};
