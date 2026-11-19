import { SidecarMetadataStorageService } from "@/modules/metadata-sidecars/sidecar-metadata-storage.service";
import { sidecarMetadataWriter } from "@/modules/metadata-sidecars/sidecar-metadata-writer.runtime";
import { createMediaFileProcessor } from "@/modules/scanner/processing/media-file.processor";
import { importSidecarSubtitles } from "@/modules/scanner/processing/sidecar-subtitles.utils";
import { librariesRepository } from "@/repositories/libraries.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import { scanFindingsRepository } from "@/repositories/scan-findings.repository";
import { MetadataProcess } from "@/services/catalog/metadata/process/metadata-process.service";
import { findIngestLibrary } from "@/services/libraries/ingest-library.cache";
import { pluginEventBus } from "@/system/extensions/plugin.events";
import { enqueueMediaFileAnalysis } from "@/workers/definitions/media/media-file-analysis.worker";
import { enqueueTrickplayGenerationForLibrary } from "@/workers/definitions/media/trickplay-generate.worker";
import type { MediaFileIngestTaskDependencies } from "./media-file-ingest.types";

let mediaFileProcessor: ReturnType<typeof createMediaFileProcessor> | undefined;

/** Built on first use: `MetadataProcess` sits in an import cycle, so it cannot be constructed at module scope. */
function getMediaFileProcessor(): ReturnType<typeof createMediaFileProcessor> {
	mediaFileProcessor ??= createMediaFileProcessor(new MetadataProcess());

	return mediaFileProcessor;
}

export const defaultDependencies: MediaFileIngestTaskDependencies = {
	findLibrary: (libraryId) => findIngestLibrary(libraryId, (id) => librariesRepository.findWithPaths(id)),
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
