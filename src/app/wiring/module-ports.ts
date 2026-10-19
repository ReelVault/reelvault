import { adminFailureNotificationService } from "@/app/admin/admin-failure-notification.service";
import { writeCoreArtifact } from "@/app/artifacts/core-artifacts.writer";
import { mediaArtifactsService } from "@/app/artifacts/media-artifacts.service";
import { databaseMaintenanceRepository } from "@/app/repositories/database-maintenance.repository";
import { downloadsRepository } from "@/app/repositories/downloads.repository";
import { episodesRepository } from "@/app/repositories/episodes.repository";
import { imageRepository } from "@/app/repositories/images.repository";
import { interruptedPlaybackSessionRepository } from "@/app/repositories/interrupted-playback-session.repository";
import { librariesRepository } from "@/app/repositories/libraries.repository";
import { liveSessionsRepository } from "@/app/repositories/live-sessions.repository";
import { mediaRepository } from "@/app/repositories/media-files.repository";
import { profilePreferencesRepository } from "@/app/repositories/profile-preferences.repository";
import { profilesRepository } from "@/app/repositories/profiles.repository";
import { resourceMetricsRepository } from "@/app/repositories/resource-metrics.repository";
import { seasonsRepository } from "@/app/repositories/seasons.repository";
import { subtitlesRepository } from "@/app/repositories/subtitles.repository";
import { usersRepository } from "@/app/repositories/users.repository";
import { workerJobRepository } from "@/app/repositories/worker.repository";
import { workerOperationRepository } from "@/app/repositories/worker-operation.repository";
import { DatabaseSidecarSnapshotResolver } from "@/app/sidecars/sidecar-snapshot.resolver";
import { CORE_ARTIFACTS_OWNER } from "@/integrations/drizzle-orm/constants/media-artifacts.constants";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { QueryFields } from "@/integrations/drizzle-orm/query/parsing/fields.parser";
import { wireDownloadsProcess, wireDownloadsStorage } from "@/modules/downloads/downloads.ports";
import { wireImagesStorage } from "@/modules/images/images.ports";
import { wireSidecarSnapshots, wireSidecarStorage } from "@/modules/metadata-sidecars/sidecar.ports";
import { wireRealtimeAccess } from "@/modules/realtime/realtime.ports";
import { wireScannerStorage } from "@/modules/scanner/scanner.ports";
import { streamingManager } from "@/modules/streaming/runtime/streaming.manager";
import { wireStreamAccessPolicy, wireStreamingStorage, wireStreamingWorker } from "@/modules/streaming/streaming.ports";
import { wireSubtitleProviders, wireSubtitlesStorage } from "@/modules/subtitles/subtitles.ports";
import { wireTrickplayStorage } from "@/modules/trickplay/trickplay.ports";
import { subtitleProviderService } from "@/plugins/capabilities/subtitle-provider.service";
import { pluginManager } from "@/plugins/lifecycle/plugin.manager";
import { pluginAccessBus } from "@/plugins/runtime/plugin.access";
import { wireResourceAllocatorStorage } from "@/system/resource-allocator/resource-allocator.ports";
import { enqueueDownloadsProcess } from "@/workers/definitions/downloads/downloads-process.worker";
import { enqueueStreamInit } from "@/workers/definitions/streaming/stream-initialization.worker";
import { workerService } from "@/workers/worker.service";

/**
 * Registers the data that modules read from the application layer. Modules
 * declare the ports, this function supplies the implementations, and the
 * composition root calls it once at startup, before the server accepts traffic.
 */
export function wireModulePorts(): void {
	registerResourceAllocatorStoragePorts();
	registerRealtimeAccessPorts();
	registerScannerStoragePorts();
	registerDownloadsStoragePorts();
	registerImagesStoragePorts();
	registerSidecarStoragePorts();
	registerSidecarSnapshotsPorts();
	registerStreamingStoragePorts();
	registerSubtitlesStoragePorts();
	registerTrickplayStoragePorts();
	registerDownloadsProcessPorts();
	registerStreamingWorkerPorts();
	registerStreamAccessPolicyPorts();
	registerSubtitleProviderPorts();
}

function registerDownloadsProcessPorts(): void {
	wireDownloadsProcess({
		enqueueProcess: (downloadId) => enqueueDownloadsProcess(downloadId),
	});
}

function registerStreamingWorkerPorts(): void {
	wireStreamingWorker({
		cancelOperation: (operationId) => workerService.cancelOperation(operationId),
		createOperation: (input) => workerService.createOperation(input),
		removeOperation: (operationId) => workerService.removeOperation(operationId),
		enqueueStreamInit: (data, options) => enqueueStreamInit(data, options),
	});
}

function registerStreamAccessPolicyPorts(): void {
	wireStreamAccessPolicy({
		check: (context) => pluginAccessBus.check(context),
	});
}

function registerSubtitleProviderPorts(): void {
	wireSubtitleProviders({
		getProviderStatus: () => pluginManager.getSubtitleProviderStatus(),
		search: (request) => subtitleProviderService.search(request),
		download: (providerId, request) => subtitleProviderService.download(providerId, request),
		disabledProviderIds: () => subtitleProviderService.disabledProviderIds(),
		setEnabled: (providerId, enabled) => subtitleProviderService.setEnabled(providerId, enabled),
		getContent: (subtitleId) => subtitleProviderService.getContent(subtitleId),
	});
}

function registerRealtimeAccessPorts(): void {
	wireRealtimeAccess({
		findAdminUserIds: async (userIds) => await usersRepository.findAdminIdsByUserIds(userIds),
		findProfile: async (profileId) => await profilesRepository.findByPrimaryIdCached(profileId),
	});
}

function registerScannerStoragePorts(): void {
	wireScannerStorage({
		deleteByLibraryAndPaths: async (libraryId, filePaths) =>
			await mediaRepository.deleteByLibraryAndPathsAndGetCleanup(libraryId, filePaths),
		removeArtifactStorageFiles: async (keys) => await mediaArtifactsService.removeStorageFiles(keys),
		invalidateArtifactByteTotals: () => mediaArtifactsService.invalidateByteTotals(),
		clearLibraryStatsCache: () => librariesRepository.clearStatsCache(),
		findStatsPage: async (libraryId, cursor, limit) => await mediaRepository.findStatsByLibraryIdPage(libraryId, cursor, limit),
		findIdByFilePath: async (filePath) => await mediaRepository.findIdByFilePath(filePath),
		optimizeDatabase: () => databaseFactory.optimize(),
	});
}

function registerDownloadsStoragePorts(): void {
	wireDownloadsStorage({
		insert: async (values) => await downloadsRepository.insert(values),
		findById: async (id) => await downloadsRepository.findById(id),
		findByProfile: async (profileId) => await downloadsRepository.findByProfile(profileId),
		findPage: async (query) => await downloadsRepository.findPage(query),
		countByStatus: async () => await downloadsRepository.countByStatus(),
		findExistingIds: async (ids) => await downloadsRepository.findExistingIds(ids),
		findByStatuses: async (statuses) => await downloadsRepository.findByStatuses(statuses),
		findExpired: async (retentionDays) => await downloadsRepository.findExpired(retentionDays),
		storageUsedByProfile: async (profileId) => await downloadsRepository.storageUsedByProfile(profileId),
		countProcessingByProfile: async (profileId) => await downloadsRepository.countProcessingByProfile(profileId),
		countPendingByProfile: async (profileId) => await downloadsRepository.countPendingByProfile(profileId),
		hasActiveByProfileAndMedia: async (profileId, mediaFileId) =>
			await downloadsRepository.hasActiveByProfileAndMedia(profileId, mediaFileId),
		findPendingByProfile: async (profileId, limit) => await downloadsRepository.findPendingByProfile(profileId, limit),
		claimForProcessing: async (id, profileId, maxRunning) => await downloadsRepository.claimForProcessing(id, profileId, maxRunning),
		update: async (id, values) => await downloadsRepository.update(id, values),
		delete: async (id) => await downloadsRepository.delete(id),
		findMediaFileForDownload: async (mediaFileId) =>
			await mediaRepository.findByPrimaryId({
				primaryId: mediaFileId,
				fields: QueryFields.parse({ fields: "id,filePath,duration,fileName" }),
			}),
		findMediaIdentities: async (mediaFileIds) => await mediaRepository.findIdentitiesByIds(mediaFileIds),
		findSeasonForDownload: async (seasonId) =>
			await seasonsRepository.findByPrimaryId({
				primaryId: seasonId,
				fields: QueryFields.parse({ fields: "id,metadataId" }),
			}),
		findEpisodeFilesByMetadataId: async (metadataId) => await episodesRepository.findEpisodesWithFilesByMetadataId(metadataId),
	});
}

function registerImagesStoragePorts(): void {
	wireImagesStorage({
		findForFileRead: async (imageId) => await imageRepository.findForFileRead(imageId),
		deleteAndReturn: async (imageId) => await imageRepository.deleteAndReturn(imageId),
		findMetadataImagePath: async (metadataId, imageType) => await imageRepository.findMetadataImagePath(metadataId, imageType),
		findAllImageStorageIdentifiers: async () => await imageRepository.findAllImageStorageIdentifiers(),
		findOutdatedImageIds: async (currentVersion) => await imageRepository.findOutdatedImageIds(currentVersion),
		findImageOptimizationCandidate: async (imageId, currentVersion) =>
			await imageRepository.findImageOptimizationCandidate(imageId, currentVersion),
		markImageOptimizationVersion: async (imageId, currentVersion, values) =>
			await imageRepository.markImageOptimizationVersion(imageId, currentVersion, values),
		getMetadataTarget: async (metadataId, type) => await imageRepository.getMetadataTarget(metadataId, type),
		replaceMetadataImage: async (metadataId, type, image) => await imageRepository.replaceMetadataImage(metadataId, type, image),
		getSeasonTarget: async (metadataId, seasonId) => await imageRepository.getSeasonTarget(metadataId, seasonId),
		replaceSeasonImage: async (metadataId, seasonId, image) => await imageRepository.replaceSeasonImage(metadataId, seasonId, image),
		getEpisodeTarget: async (metadataId, episodeId) => await imageRepository.getEpisodeTarget(metadataId, episodeId),
		replaceEpisodeImage: async (metadataId, episodeId, image) => await imageRepository.replaceEpisodeImage(metadataId, episodeId, image),
		getPersonTarget: async (personId) => await imageRepository.getPersonTarget(personId),
		replacePersonImage: async (personId, image) => await imageRepository.replacePersonImage(personId, image),
		getProfileAvatarTarget: async (profileId) => await imageRepository.getProfileAvatarTarget(profileId),
		replaceProfileAvatar: async (profileId, image) => await imageRepository.replaceProfileAvatar(profileId, image),
	});
}

function registerSidecarStoragePorts(): void {
	wireSidecarStorage({
		findEpisodeRecords: async (ids) =>
			await episodesRepository.findRecordsByIds({
				ids,
				fields: QueryFields.parse({ fields: "id,seasonId,title,episodeNumber,airDate,overview,imageId" }),
			}),
		findSeasonRecords: async (ids) =>
			await seasonsRepository.findByIds({
				ids,
				fields: QueryFields.parse({ fields: "id,seasonNumber,name,airDate,overview,status,imageId" }),
			}),
		findRootMediaFiles: async (metadataId) => await mediaRepository.findRootsByMetadataId(metadataId),
		findLibraryWithPaths: async (libraryId) => await librariesRepository.findWithPaths(libraryId),
		findLibraryPaths: async (libraryId) => await librariesRepository.findByIdForRead(libraryId, { fields: "id,paths.path" }),
		shutdownDatabaseFile: (databasePath) => databaseMaintenanceRepository.shutdownIfConfiguredDatabasePath(databasePath),
	});
}

function registerSidecarSnapshotsPorts(): void {
	wireSidecarSnapshots(new DatabaseSidecarSnapshotResolver());
}

function registerStreamingStoragePorts(): void {
	wireStreamingStorage({
		findMediaSummaries: async (mediaFileIds) => await liveSessionsRepository.findMediaSummaries(mediaFileIds),
		markStreamAttached: async (operationId) => await workerOperationRepository.markStreamAttached(operationId),
		updateOperationProgress: async (operationId, progressPercent) => {
			await workerOperationRepository.updateProgress(operationId, progressPercent);
		},
		completeStreamOperation: async (operationId) => {
			await workerOperationRepository.completeStreamSlot(operationId);
		},
		releaseStreamOperation: async (operationId) => {
			await workerOperationRepository.releaseStreamSlot(operationId);
		},
		findActiveOperations: async (operationIds) => await workerJobRepository.findActiveOperations(operationIds),
		recordInterruptedSession: async (record) => {
			await interruptedPlaybackSessionRepository.insert(record);
		},
		findPlaybackSessionData: async (mediaFileId, profileId, thresholdSeconds) =>
			await mediaRepository.findPlaybackSessionData(mediaFileId, profileId, thresholdSeconds),
		findForStreamingDiagnostics: async (mediaFileId) => await mediaRepository.findForStreamingDiagnostics(mediaFileId),
		findForStreamingDuration: async (mediaFileId) => await mediaRepository.findForStreamingDuration(mediaFileId),
		getEffectivePreferences: async (profileId) => await profilePreferencesRepository.getEffective({ profileId }),
	});
}

function registerSubtitlesStoragePorts(): void {
	wireSubtitlesStorage({
		findPage: async (query) => await subtitlesRepository.findPage(query),
		findByMediaFileId: async (mediaFileId) => await subtitlesRepository.findByMediaFileId(mediaFileId),
		findById: async (id) => await subtitlesRepository.findByPrimaryId({ primaryId: id }),
		createRow: async (body, type) => await subtitlesRepository.createAndRead(body, type),
		updateRow: async (id, body) => await subtitlesRepository.updateAndRead(id, body),
		deleteRow: async (id) => await subtitlesRepository.deleteAndReturn(id),
		findMediaFilePath: async (mediaFileId) => (await mediaRepository.findForSubtitleExtraction(mediaFileId))?.filePath ?? null,
		findExternalLanguages: async (mediaFileId) => await subtitlesRepository.findExternalLanguagesByMediaFile(mediaFileId),
		insertExternal: async (values) => (await subtitlesRepository.insertReturning({ values, onConflict: "doNothing" })).length,
	});
}

function registerTrickplayStoragePorts(): void {
	wireTrickplayStorage({
		findSource: async (mediaFileId) => {
			const mediaFile = await mediaRepository.findByPrimaryId({
				primaryId: mediaFileId,
				fields: QueryFields.parse({ fields: "id,filePath,duration" }),
			});

			return mediaFile ? { filePath: mediaFile.filePath, duration: mediaFile.duration ?? null } : undefined;
		},
		writeArtifact: async (artifact) => await writeCoreArtifact(artifact),
		removePreviews: async (mediaFileId) =>
			await mediaArtifactsService.deleteByMediaFileIdAndKind(mediaFileId, "trickplay", CORE_ARTIFACTS_OWNER),
		storedBytes: async () => await mediaArtifactsService.getStoredBytes(CORE_ARTIFACTS_OWNER),
		mediaFileStoredBytes: async (mediaFileId) => await mediaArtifactsService.getMediaFileStoredBytes(mediaFileId, CORE_ARTIFACTS_OWNER),
	});
}

function registerResourceAllocatorStoragePorts(): void {
	wireResourceAllocatorStorage({
		recordMetrics: async (sample) => {
			await resourceMetricsRepository.create(sample);
		},
		notifyAlert: (code, params) => adminFailureNotificationService.notifyResourceAlert(code, params),
		activeStreamCount: () => streamingManager.getActiveSessions(),
	});
}
