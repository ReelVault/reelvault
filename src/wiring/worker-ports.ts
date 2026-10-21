import { pluginBlobsService } from "@/plugins/capabilities/plugin.blobs";
import { pluginMediaService } from "@/plugins/capabilities/plugin.media";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
import { adminAuditRepository } from "@/repositories/admin-audit.repository";
import { interruptedPlaybackSessionRepository } from "@/repositories/interrupted-playback-session.repository";
import { librariesRepository } from "@/repositories/libraries.repository";
import { mediaRepository } from "@/repositories/media-files.repository";
import { mediaMarkersRepository } from "@/repositories/media-markers.repository";
import { resourceMetricsRepository } from "@/repositories/resource-metrics.repository";
import { scanFindingsRepository } from "@/repositories/scan-findings.repository";
import { scanStateRepository } from "@/repositories/scan-state.repository";
import { subtitlesRepository } from "@/repositories/subtitles.repository";
import { watchedHistoryRepository } from "@/repositories/watched-history.repository";
import { workerJobRepository } from "@/repositories/worker.repository";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { workerSchedulesRepository } from "@/repositories/worker-schedules.repository";
import { adminFailureNotificationService } from "@/services/admin/admin-failure-notification.service";
import { adminLogsService } from "@/services/admin/admin-logs.service";
import { databaseBackupService } from "@/services/admin/database-backup.service";
import { MetadataProcess } from "@/services/catalog/metadata/process/metadata-process.service";
import { metadataRefreshService } from "@/services/catalog/metadata/refresh/metadata-refresh.runtime";
import { auditMediaFileRow, buildMediaFileAuditReport } from "@/services/media/media-files/media-file-audit.utils";
import { mediaFileRefreshService } from "@/services/media/media-files/refresh-media-file.operation";
import { updateNotificationService } from "@/services/updates/update-notification.service";
import { wireWorkerDependencies } from "@/workers/worker.ports";

/** Hands the worker runtime and its handlers their stores and services. Called at startup, before any worker runs. */
export function wireWorkerPorts(): void {
	wireWorkerDependencies({
		jobs: workerJobRepository,
		operations: workerOperationRepository,
		schedules: workerSchedulesRepository,
		media: mediaRepository,
		libraries: librariesRepository,
		mediaMarkers: mediaMarkersRepository,
		scanFindings: scanFindingsRepository,
		scanState: scanStateRepository,
		subtitles: subtitlesRepository,
		adminAudit: adminAuditRepository,
		interruptedPlayback: interruptedPlaybackSessionRepository,
		watchedHistory: watchedHistoryRepository,
		resourceMetrics: resourceMetricsRepository,
		services: {
			adminFailureNotifications: {
				notifyWorkerFailed: (workerId, errorText) => adminFailureNotificationService.notifyWorkerFailed(workerId, errorText),
			},
			adminLogs: {
				purgeOldLogs: (retentionDays, context, signal) => adminLogsService.purgeOldLogs(retentionDays, context, signal),
			},
			databaseBackup: {
				createBackup: () => databaseBackupService.createBackup(),
			},
			updateNotifications: {
				notifyIfUpdateAvailable: (forceCheck) => updateNotificationService.notifyIfUpdateAvailable(forceCheck),
			},
			mediaFileRefresh: {
				queue: (mediaFileId, options) => mediaFileRefreshService.queue(mediaFileId, options),
			},
			metadataRefresh: {
				refresh: (metadataId, options) => metadataRefreshService.refresh(metadataId, options),
			},
			metadataProcess: new MetadataProcess(),
			mediaAudit: {
				buildReport: () => buildMediaFileAuditReport(),
				isSuspect: async (mediaFileId) => {
					const row = await mediaRepository.findAuditRow(mediaFileId);

					return row ? auditMediaFileRow(row) !== null : false;
				},
			},
			pluginBlobs: {
				purgeExpired: (signal) => pluginBlobsService.purgeExpired(signal),
			},
			pluginMedia: {
				get: (mediaFileId) => pluginMediaService.get(mediaFileId),
			},
			pluginRegistry: {
				analyzeMedia: (media) => pluginRegistry.analyzeMedia(media),
			},
		},
	});
}
