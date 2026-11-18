import type { WorkerDefinition } from "@reelvault/sdk";

/**
 * Every built-in worker, in registration order. Each entry imports its module
 * lazily — a static import would evaluate worker definitions at load time and
 * hit a TDZ cycle (see built-in-workers.test.ts). Adding a worker means adding
 * one row here: the import, the export it picks and the definition list are no
 * longer three parallel lists that can drift apart.
 */
const BUILT_IN_WORKERS = [
	async () => (await import("./definitions/system/check-updates.worker")).checkUpdatesWorker,
	async () => (await import("./definitions/images/image-processing.worker")).imageProcessingWorker,
	async () => (await import("./definitions/images/image-optimization.worker")).imageOptimizationWorker,
	async () => (await import("./definitions/images/image-optimization.worker")).imageOptimizationScanWorker,
	async () => (await import("./definitions/libraries/library-errors-check.worker")).libraryErrorsCheckWorker,
	async () => (await import("./definitions/libraries/library-scan.worker")).libraryScanWorker,
	async () => (await import("./definitions/media/media-file-analysis.worker")).mediaFileAnalysisWorker,
	async () => (await import("./definitions/media/media-file-audit.worker")).mediaFileAuditWorker,
	async () => (await import("./definitions/media/media-file-audit.worker")).mediaFileAuditReportWorker,
	async () => (await import("./definitions/media/media-file-audit.worker")).mediaMatchAuditScanWorker,
	async () => (await import("./definitions/media/media-file-ingest.worker")).mediaFileIngestWorker,
	async () => (await import("./definitions/media/media-file-technical-refresh.worker")).mediaFileTechnicalRefreshWorker,
	async () => (await import("./definitions/media/media-files-refresh-all.worker")).mediaFilesRefreshAllWorker,
	async () => (await import("./definitions/metadata/metadata-refresh.worker")).metadataRefreshWorker,
	async () => (await import("./definitions/streaming/stream-initialization.worker")).streamInitWorker,
	async () => (await import("./definitions/media/trickplay-generate.worker")).trickplayGenerateWorker,
	async () => (await import("./definitions/downloads/downloads-process.worker")).downloadsProcessWorker,
	async () => (await import("./definitions/system/database-backup.worker")).databaseBackupWorker,
	async () => (await import("./definitions/system/cleanup-database.worker")).cleanupDatabaseWorker,
	async () => (await import("./definitions/system/cleanup-worker-history.worker")).cleanupWorkerHistoryWorker,
	async () => (await import("./definitions/system/cleanup-transcodes.worker")).cleanupTranscodesWorker,
	async () => (await import("./definitions/system/cleanup-plugin-blobs.worker")).cleanupPluginBlobsWorker,
	async () => (await import("./definitions/system/cleanup-metrics.worker")).cleanupMetricsWorker,
	async () => (await import("./definitions/system/cleanup-orphan-images.worker")).cleanupOrphanImagesWorker,
	async () => (await import("./definitions/system/cleanup-orphan-media-files.worker")).cleanupOrphanMediaFilesWorker,
	async () => (await import("./definitions/system/cleanup-orphan-subtitles.worker")).cleanupOrphanSubtitlesWorker,
	async () => (await import("./definitions/system/cleanup-logs.worker")).cleanupLogsWorker,
] as const satisfies ReadonlyArray<() => Promise<WorkerDefinition>>;

export async function loadBuiltInWorkers(): Promise<WorkerDefinition[]> {
	return await Promise.all(BUILT_IN_WORKERS.map((load) => load()));
}
