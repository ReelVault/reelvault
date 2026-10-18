import { adminFailureNotificationService } from "@/app/admin/admin-failure-notification.service";
import { adminLogsService } from "@/app/admin/admin-logs.service";
import { databaseBackupService } from "@/app/admin/database-backup.service";
import { MetadataProcess } from "@/app/catalog/metadata/process/metadata-process.service";
import { metadataRefreshService } from "@/app/catalog/metadata/refresh/metadata-refresh.runtime";
import { auditMediaFileRow, buildMediaFileAuditReport } from "@/app/media/media-files/media-file-audit.utils";
import { mediaFileRefreshService } from "@/app/media/media-files/refresh-media-file.operation";
import { adminAuditRepository } from "@/app/repositories/admin-audit.repository";
import { interruptedPlaybackSessionRepository } from "@/app/repositories/interrupted-playback-session.repository";
import { librariesRepository } from "@/app/repositories/libraries.repository";
import { mediaRepository } from "@/app/repositories/media-files.repository";
import { mediaMarkersRepository } from "@/app/repositories/media-markers.repository";
import { resourceMetricsRepository } from "@/app/repositories/resource-metrics.repository";
import { scanFindingsRepository } from "@/app/repositories/scan-findings.repository";
import { scanStateRepository } from "@/app/repositories/scan-state.repository";
import { subtitlesRepository } from "@/app/repositories/subtitles.repository";
import { watchedHistoryRepository } from "@/app/repositories/watched-history.repository";
import { workerJobRepository } from "@/app/repositories/worker.repository";
import { workerOperationRepository } from "@/app/repositories/worker-operation.repository";
import { workerSchedulesRepository } from "@/app/repositories/worker-schedules.repository";
import { updateNotificationService } from "@/app/updates/update-notification.service";
import { pluginBlobsService } from "@/plugins/capabilities/plugin.blobs";
import { pluginMediaService } from "@/plugins/capabilities/plugin.media";
import { pluginRegistry } from "@/plugins/lifecycle/plugin.registry";
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
