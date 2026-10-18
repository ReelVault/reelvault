import { schema } from "@/integrations/drizzle-orm/database.schema";
import { findIngestProgress, markIngestDiscoveredEmitted, markIngestSidecarWritten } from "./media-files/ingest.writer";
import {
	findAuditRow,
	findForPlaybackSession,
	findForStreamingDiagnostics,
	findForStreamingDuration,
	findForSubtitleExtraction,
	findForTechnicalRefresh,
	scanAuditRowIds,
	scanAuditRows,
} from "./media-files/playback.reader";
import { findEpisodeFileRowsForPlugins, findFileRowsPageForPlugins } from "./media-files/plugin-media.reader";
import {
	findByFilePath,
	findByIdForRead,
	findByLibraryAndPaths,
	findByPrimaryId,
	findCleanupData,
	findCleanupDataByMediaFileIds,
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

export type { MediaFileAuditRow };

/**
 * Facade over the media file store. The behavior lives in `media-files/`, grouped
 * into queries, playback reads, writes and ingest state; the class keeps the singleton API.
 */
class MediaRepository {
	readonly table = schema.mediaFiles;
	readonly primaryKeyColumn = mediaFiles.primaryKeyColumn;
	readonly query = mediaFiles.query;
	readonly selectMany = mediaFiles.selectMany;
	readonly selectFirst = mediaFiles.selectFirst;
	readonly selectFirstById = mediaFiles.selectFirstById;
	readonly findOrCreate = mediaFiles.findOrCreate;
	readonly insert = mediaFiles.insert;
	readonly update = mediaFiles.update;
	readonly delete = mediaFiles.delete;
	readonly count = mediaFiles.count;
	readonly isExists = mediaFiles.isExists;
	readonly insertReturning = mediaFiles.insertReturning;
	readonly updateReturning = mediaFiles.updateReturning;
	readonly updateAndReturn = mediaFiles.updateAndReturn;
	readonly deleteReturning = mediaFiles.deleteReturning;
	readonly deleteAndReturn = mediaFiles.deleteAndReturn;
	readonly findByIds = mediaFiles.findByIds;
	readonly findByColumnIn = mediaFiles.findByColumnIn;
	readonly insertVideoStreams = mediaFileVideoStreams.insert;
	readonly insertAudioStreams = mediaFileAudioStreams.insert;
	readonly insertSubtitles = mediaFileSubtitles.insert;
	readonly deleteSubtitles = mediaFileSubtitles.delete;
	readonly deleteVideoStreams = mediaFileVideoStreams.delete;
	readonly deleteAudioStreams = mediaFileAudioStreams.delete;

	readonly findPage = findPage;
	readonly findByIdForRead = findByIdForRead;
	readonly updateAndRead = updateAndRead;
	readonly deleteAndGetCleanup = deleteAndGetCleanup;
	readonly reassign = reassign;
	readonly findIdByFilePath = findIdByFilePath;
	readonly ping = ping;
	readonly findForTechnicalRefresh = findForTechnicalRefresh;
	readonly findForPlaybackSession = findForPlaybackSession;
	readonly findForStreamingDuration = findForStreamingDuration;
	readonly findForStreamingDiagnostics = findForStreamingDiagnostics;
	readonly findForSubtitleExtraction = findForSubtitleExtraction;
	readonly replaceTechnicalData = replaceTechnicalData;
	readonly deleteByLibraryAndPathsAndGetCleanup = deleteByLibraryAndPathsAndGetCleanup;
	readonly findAuditRow = findAuditRow;
	readonly scanAuditRows = scanAuditRows;
	readonly scanAuditRowIds = scanAuditRowIds;
	readonly createWithStreams = createWithStreams;
	readonly markIngestSidecarWritten = markIngestSidecarWritten;
	readonly markIngestDiscoveredEmitted = markIngestDiscoveredEmitted;
	readonly findIngestProgress = findIngestProgress;
	readonly replaceStreams = replaceStreams;
	readonly replaceEmbeddedSubtitles = replaceEmbeddedSubtitles;
	readonly setDefault = setDefault;
	readonly findMany = findMany;
	readonly findRootsByMetadataId = findRootsByMetadataId;
	readonly scanAllIdentities = scanAllIdentities;
	readonly findIdentity = findIdentity;
	readonly findIdentitiesByIds = findIdentitiesByIds;
	readonly findByPrimaryId = findByPrimaryId;
	readonly findByFilePath = findByFilePath;
	readonly findStatsByLibraryIdPage = findStatsByLibraryIdPage;
	readonly findByLibraryAndPaths = findByLibraryAndPaths;
	readonly deleteByLibraryAndPaths = deleteByLibraryAndPaths;
	readonly findCleanupDataByMediaFileIds = findCleanupDataByMediaFileIds;
	readonly findCleanupData = findCleanupData;
	readonly findOrphanedMediaFileIds = findOrphanedMediaFileIds;
	readonly deleteByIds = deleteByIds;
	readonly findEpisodeFileRowsForPlugins = findEpisodeFileRowsForPlugins;
	readonly findFileRowsPageForPlugins = findFileRowsPageForPlugins;
	readonly findIdsByMetadataIds = findIdsByMetadataIds;
}

export const mediaRepository = new MediaRepository();
