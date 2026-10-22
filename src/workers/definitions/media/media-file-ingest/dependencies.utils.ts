import type { LibraryWithRelations } from "@reelvault/sdk/common";
import { SidecarMetadataStorageService } from "@/modules/metadata-sidecars/sidecar-metadata-storage.service";
import { sidecarMetadataWriter } from "@/modules/metadata-sidecars/sidecar-metadata-writer.runtime";
import { createMediaFileProcessor } from "@/modules/scanner/processing/media-file.processor";
import { importSidecarSubtitles } from "@/modules/scanner/processing/sidecar-subtitles.utils";
import { librariesRepository } from "@/repositories/libraries.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import { scanFindingsRepository } from "@/repositories/scan-findings.repository";
import { MetadataProcess } from "@/services/catalog/metadata/process/metadata-process.service";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { MemoryCache } from "@/utils/memory.cache";
import { enqueueMediaFileAnalysis } from "@/workers/definitions/media/media-file-analysis.worker";
import { enqueueTrickplayGenerationForLibrary } from "@/workers/definitions/media/trickplay-generate.worker";
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
	mediaFileProcessor ??= createMediaFileProcessor(new MetadataProcess());

	return mediaFileProcessor;
}

export const defaultDependencies: MediaFileIngestTaskDependencies = {
	findLibrary: async (libraryId) => {
		const cached = ingestLibraryCache.get(libraryId);
		if (cached) return cached;

		const library = await librariesRepository.findWithPaths(libraryId);
		if (library) ingestLibraryCache.set(libraryId, library);

		return library;
	},
	processFile: (libraryType, filePath, skipExistingLookup, options) =>
		getMediaFileProcessor().process(libraryType, filePath, skipExistingLookup, options),
	upsertScanFinding: (finding) => scanFindingsRepository.upsert(finding),
	deleteScanFinding: (libraryId, filePath) => scanFindingsRepository.remove(libraryId, filePath),
	createMediaFile: (data) => mediaRepository.createWithStreams(data),
	importSidecarSubtitles: (mediaFileId, videoFilePath) => importSidecarSubtitles(mediaFileId, videoFilePath),
	findMediaByPaths: (libraryId, filePaths) => mediaRepository.findByLibraryAndPaths({ libraryId, filePaths }),
	saveSidecars: (library, mediaFiles) => new SidecarMetadataStorageService(sidecarMetadataWriter).saveLibraryMedia(library, mediaFiles),
	emitMediaDiscovered: (input) => pluginEventBus.emit("media.file.discovered", input),
	emitMediaIdentified: (input) => pluginEventBus.emit("media.file.identified", input),
	readIngestProgress: (mediaFileId) => mediaRepository.findIngestProgress(mediaFileId),
	markSidecarWritten: (mediaFileId) => mediaRepository.markIngestSidecarWritten(mediaFileId),
	markDiscoveredEmitted: (mediaFileId) => mediaRepository.markIngestDiscoveredEmitted(mediaFileId),
	enqueueTrickplayGeneration: (mediaFileId, libraryId) => enqueueTrickplayGenerationForLibrary(mediaFileId, libraryId),
	enqueueAnalysis: (data, options) => enqueueMediaFileAnalysis(data, options ?? {}),
};
