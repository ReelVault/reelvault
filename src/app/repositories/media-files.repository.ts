import { defineRepository } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { findIngestProgress, markIngestDiscoveredEmitted, markIngestSidecarWritten } from "./media-files/ingest.writer";
import {
	findAuditRow,
	findForPlaybackSession,
	findForStreamingDiagnostics,
	findForStreamingDuration,
	findForSubtitleExtraction,
	findForTechnicalRefresh,
	findPlaybackSessionData,
	scanAuditRowIds,
	scanAuditRows,
} from "./media-files/playback.reader";
import { findPlaybackContext } from "./media-files/playback-context.reader";
import { findEpisodeFileRowsForPlugins, findFileRowsPageForPlugins } from "./media-files/plugin-media.reader";
import {
	findByFilePath,
	findByIdForRead,
	findByLibraryAndPaths,
	findByPrimaryId,
	findCleanupData,
	findCleanupDataByMediaFileIds,
	findExistingIds,
	findIdByFilePath,
	findIdentitiesByIds,
	findIdentity,
	findIdsByMetadataIds,
	findMany,
	findOrphanedMediaFileIds,
	findPage,
	findRootsByMetadataId,
	findStatsByLibraryIdPage,
	ping,
	scanAllIdentities,
} from "./media-files/queries.reader";
import {
	type MediaFileAuditRow,
	mediaFileAudioStreams,
	mediaFileSubtitles,
	mediaFiles,
	mediaFileVideoStreams,
} from "./media-files/shared.utils";
import {
	createWithStreams,
	deleteAndGetCleanup,
	deleteByIds,
	deleteByLibraryAndPaths,
	deleteByLibraryAndPathsAndGetCleanup,
	reassign,
	replaceEmbeddedSubtitles,
	replaceStreams,
	replaceTechnicalData,
	setDefault,
	updateAndRead,
} from "./media-files/writes.writer";

export type { PlaybackContext } from "./media-files/playback-context.reader";
export type { MediaFileAuditRow };

/**
 * Facade over the media file store. The behavior lives in `media-files/`, grouped
 * into queries, playback reads, writes and ingest state; this object keeps the
 * singleton API and the stream/subtitle writes; the table-access delegations
 * come from `defineRepository`.
 */
const overrides = {
	insertVideoStreams: mediaFileVideoStreams.insert,
	insertAudioStreams: mediaFileAudioStreams.insert,
	insertSubtitles: mediaFileSubtitles.insert,
	deleteSubtitles: mediaFileSubtitles.delete,
	deleteVideoStreams: mediaFileVideoStreams.delete,
	deleteAudioStreams: mediaFileAudioStreams.delete,

	findPage,
	findByIdForRead,
	updateAndRead,
	deleteAndGetCleanup,
	reassign,
	findIdByFilePath,
	ping,
	findExistingIds,
	findForTechnicalRefresh,
	findForPlaybackSession,
	findPlaybackSessionData,
	findForStreamingDuration,
	findForStreamingDiagnostics,
	findForSubtitleExtraction,
	replaceTechnicalData,
	deleteByLibraryAndPathsAndGetCleanup,
	findAuditRow,
	scanAuditRows,
	scanAuditRowIds,
	createWithStreams,
	markIngestSidecarWritten,
	markIngestDiscoveredEmitted,
	findIngestProgress,
	replaceStreams,
	replaceEmbeddedSubtitles,
	setDefault,
	findMany,
	findRootsByMetadataId,
	scanAllIdentities,
	findIdentity,
	findIdentitiesByIds,
	findByPrimaryId,
	// The generic table-access `findById` twin returns the flat row; keep the
	// hydrating read behind the same name (see AGENTS.md on repository twins).
	findById: findByPrimaryId,
	findByFilePath,
	findStatsByLibraryIdPage,
	findByLibraryAndPaths,
	deleteByLibraryAndPaths,
	findCleanupDataByMediaFileIds,
	findCleanupData,
	findOrphanedMediaFileIds,
	deleteByIds,
	findEpisodeFileRowsForPlugins,
	findFileRowsPageForPlugins,
	findIdsByMetadataIds,
	findPlaybackContext,
};

export const mediaRepository = defineRepository(mediaFiles, overrides);
