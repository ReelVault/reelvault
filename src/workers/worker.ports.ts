import type {
	CreateMediaFile,
	CreateMediaMarker,
	LibraryWithRelations,
	MediaFileAuditResponse,
	PluginMediaFile,
	TaskTrigger,
	WorkerBackoffType,
} from "@reelvault/sdk/common";
import type { MediaAnalysis } from "@reelvault/sdk/plugin";
import type { ScanFindingReason } from "@/integrations/drizzle-orm/constants/scan-findings.constants";
import type { schema } from "@/integrations/drizzle-orm/database.schema";
import type { MetadataMatcher } from "@/modules/scanner/processing/media-file.processor";
import { DomainError } from "@/utils/domain.errors";
import type { TaskSchedulingOptions } from "@/utils/task-context.types";
import type { MetadataRefreshResult } from "@/workers/definitions/metadata/metadata-refresh.worker";

// Row and input shapes the worker runtime reads and writes. The stores live in app/ and
// satisfy these ports structurally; workers never import the repositories.

export type WorkerItem = typeof schema.workerJobs.$inferSelect;
export type WorkerItemStatus = WorkerItem["status"];
export type WorkerItemSummary = Omit<WorkerItem, "data">;
export type ActiveWorkerItem = Pick<WorkerItem, "id" | "operationId">;

export interface WorkerItemStats {
	workerId: string;
	status: WorkerItemStatus;
	count: number;
}

export interface EnqueueWorkerItemInput {
	id: string;
	workerId: string;
	operationId?: string | undefined;
	dependsOnJobId?: string | undefined;
	dependsOnTaskIds?: string[] | undefined;
	data: string;
	dedupeKey?: string | undefined;
	referenceType?: string | undefined;
	referenceId?: string | undefined;
	priority: number;
	maxAttempts: number;
	backoffType: WorkerBackoffType;
	backoffDelayMs: number;
	runAt: Date;
}

export interface ClaimNextInput {
	workerId: string;
	runnerId: string;
	concurrency: number;
	timeoutMs: number;
	now: Date;
	excludeActiveIds?: string[] | undefined;
}

export interface TerminalJobPurgeOptions {
	status?: "completed" | "failed" | "cancelled" | "all_terminal" | undefined;
	cutoffDate?: Date | undefined;
}

export type WorkerOperationRecord = typeof schema.workerOperations.$inferSelect;
export type WorkerOperationStatus = WorkerOperationRecord["status"];

export interface WorkerOperation extends WorkerOperationRecord {
	etaMs: number | null;
}

export interface CreateWorkerOperationInput {
	id: string;
	type: string;
	referenceType?: string | undefined;
	referenceId?: string | undefined;
	error?: string | undefined;
}

export interface TerminalOperationsOptions {
	status?: "completed" | "failed" | "cancelled" | "all_terminal" | undefined;
	cutoffDate?: Date | undefined;
}

export interface OperationListOptions {
	status?: WorkerOperationStatus | "active" | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
}

export interface OperationItemsOptions {
	status?: "pending" | "running" | "completed" | "failed" | "cancelled" | undefined;
	search?: string | undefined;
	limit?: number | undefined;
	offset?: number | undefined;
}

export type WorkerSchedule = typeof schema.workerSchedules.$inferSelect;

export interface WorkerExecutionRecord {
	status: "completed" | "failed" | "cancelled";
	startedAt?: Date | undefined;
	completedAt: Date;
	durationMs: number;
	error?: string | undefined;
}

export interface WorkerJobStore {
	enqueue(input: EnqueueWorkerItemInput): Promise<WorkerItem>;
	enqueueMany(inputs: EnqueueWorkerItemInput[], options?: { countOperationTotals?: boolean | undefined }): Promise<WorkerItem[]>;
	findItem(id: string): Promise<WorkerItem | undefined>;
	findActiveByDedupeKey(workerId: string, dedupeKey: string): Promise<ActiveWorkerItem | undefined>;
	findActiveByWorkerAndDedupeKeys(workerId: string, dedupeKeys: readonly string[]): Promise<ActiveWorkerItem[]>;
	listItems(options: { limit: number; offset: number; workerId?: string | undefined; status?: WorkerItemStatus | undefined }): Promise<{
		items: WorkerItemSummary[];
		total: number;
	}>;
	findPendingWorkerIds(now?: Date): Promise<string[]>;
	claimNextBatch(input: ClaimNextInput, max: number): Promise<WorkerItem[]>;
	updateProgress(id: string, progressPercent: number, claimToken?: string): Promise<void>;
	complete(id: string, runnerId: string, result: string, claimToken?: string): Promise<boolean>;
	retry(id: string, runnerId: string, runAt: Date, error: string, claimToken?: string): Promise<boolean>;
	fail(id: string, runnerId: string, error: string, claimToken?: string): Promise<boolean>;
	requeueRunning(id: string, runnerId: string, reason: string, claimToken?: string): Promise<boolean>;
	cancelPending(id: string): Promise<boolean>;
	cancelRunning(id: string, claimToken?: string): Promise<boolean>;
	cancelPendingByOperation(operationId: string): Promise<number>;
	cancelAllPending(workerId?: string): Promise<number>;
	cancelAllRunning(workerId?: string): Promise<number>;
	findRunningByOperation(operationId: string): Promise<WorkerItem[]>;
	findByOperation(operationId: string, limit?: number): Promise<WorkerItem[]>;
	findCancelledByOperation(operationId: string, limit?: number, afterId?: string): Promise<WorkerItem[]>;
	countCancelledByOperation(operationId: string): Promise<number>;
	getStats(): Promise<WorkerItemStats[]>;
	recoverOrphanedRunning(options?: { excludeActiveIds?: string[]; currentRunnerId?: string; foreignGraceMs?: number }): Promise<number>;
	trimMany(status: WorkerItemStatus, keepCounts: ReadonlyMap<string, number>): Promise<number>;
	purgeTerminalJobs(options?: TerminalJobPurgeOptions): Promise<number>;
	countTerminalJobs(options?: TerminalJobPurgeOptions): Promise<number>;
}

export interface WorkerOperationStore {
	create(input: CreateWorkerOperationInput): Promise<WorkerOperationRecord>;
	findById(id: string): Promise<WorkerOperation | undefined>;
	findActiveByReference(type: string, referenceType: string, referenceId: string): Promise<WorkerOperationRecord | undefined>;
	list(options?: OperationListOptions): Promise<{ data: WorkerOperation[]; total: number }>;
	listItems(operationId: string, options?: OperationItemsOptions): Promise<{ items: WorkerItemSummary[]; total: number }>;
	getOperationItemsSummary(operationId: string): Promise<{
		total: number;
		pending: number;
		running: number;
		completed: number;
		failed: number;
		cancelled: number;
	}>;
	updateProgress(operationId: string, progressPercent: number): Promise<void>;
	markResumed(id: string, totalItems?: number): Promise<void>;
	requestCancel(id: string): Promise<void>;
	remove(id: string): Promise<void>;
	cleanupExpired(now?: Date): Promise<number>;
	purgeTerminalOperations(options?: TerminalOperationsOptions): Promise<{ deletedOperationsCount: number; deletedJobsCount: number }>;
	countTerminalOperations(options?: TerminalOperationsOptions): Promise<{ deletedOperationsCount: number; deletedJobsCount: number }>;
}

export interface WorkerScheduleStore {
	getAllTriggers(): Promise<Map<string, TaskTrigger[]>>;
	getAllSchedules(): Promise<Map<string, WorkerSchedule>>;
	getSchedule(workerId: string): Promise<WorkerSchedule | undefined>;
	setNextRunAt(workerId: string, nextRunAt: Date | null): Promise<void>;
	setNextRunAtMany(entries: ReadonlyArray<{ workerId: string; nextRunAt: Date | null }>): Promise<void>;
	setEnabled(workerId: string, enabled: boolean): Promise<void>;
	setTriggers(workerId: string, triggers: TaskTrigger[]): Promise<void>;
	updateExecution(workerId: string, execution: WorkerExecutionRecord): Promise<void>;
}

export interface MediaFileIdentity {
	id: string;
	metadataId: string;
}

export interface WorkerMediaFileStore {
	findForTechnicalRefresh(mediaFileId: string): Promise<
		| {
				id: string;
				libraryId: string;
				filePath: string;
				audioStreams: ReadonlyArray<{ index: number; codecName: string; language: string | null }>;
		  }
		| undefined
	>;
	replaceTechnicalData(input: {
		mediaFileId: string;
		data: Pick<
			CreateMediaFile,
			"formatName" | "duration" | "bitRate" | "source" | "edition" | "qualityTag" | "videoStreams" | "audioStreams" | "subtitles"
		>;
		size: number;
		sourceMtimeMs: number;
	}): Promise<void>;
	update(input: { primaryId: string; values: MediaAnalysis }): Promise<void>;
	scanAuditRowIds(onPage: (ids: string[]) => Promise<void> | void): Promise<number>;
	scanAllIdentities(onPage: (rows: MediaFileIdentity[]) => Promise<void> | void): Promise<number>;
	findIdentitiesByIds(ids: readonly string[]): Promise<MediaFileIdentity[]>;
	findIngestProgress(mediaFileId: string): Promise<{ sidecarWritten: boolean; discoveredEmitted: boolean }>;
	markIngestSidecarWritten(mediaFileId: string): Promise<void>;
	markIngestDiscoveredEmitted(mediaFileId: string): Promise<void>;
	findByLibraryAndPaths(input: {
		libraryId: string;
		filePaths: string[];
	}): Promise<Array<{ filePath: string; metadataId: string; movieId: string | null; episodeId: string | null }>>;
	createWithStreams(data: CreateMediaFile): Promise<{ mediaFile: { id: string }; created: boolean }>;
	findOrphanedMediaFileIds(): Promise<string[]>;
	deleteByIds(ids: string[]): Promise<number>;
}

export interface WorkerLibraryStore {
	findWithPaths(libraryId: string): Promise<LibraryWithRelations | undefined>;
	clearStatsCache(): void;
}

export interface WorkerMediaMarkerStore {
	replaceMarkersForMediaFile(
		mediaFileId: string,
		markers: readonly CreateMediaMarker[],
		options?: { source?: "automatic" | "manual" | "plugin"; pluginId?: string },
	): Promise<unknown>;
}

export interface WorkerScanFindingsStore {
	upsert(finding: { libraryId: string; filePath: string; fileName: string; reason: ScanFindingReason }): Promise<void>;
	remove(libraryId: string, filePath: string): Promise<void>;
	pruneStale(libraryId: string, scannedFilePaths: readonly string[], scannedRoots: readonly string[]): Promise<void>;
}

export interface ScanCheckpoint {
	pathsSignature: string;
	scannedFiles: number;
	newFilePaths: string[];
	changedMediaFileIds: string[];
	ingestCursor: number;
	refreshCursor: number;
}

export interface WorkerScanStateStore {
	get(libraryId: string): Promise<ScanCheckpoint | undefined>;
	set(libraryId: string, checkpoint: ScanCheckpoint): Promise<void>;
	setCursors(libraryId: string, cursors: { ingestCursor: number; refreshCursor: number }): Promise<void>;
	delete(libraryId: string): Promise<void>;
}

export interface WorkerSubtitleStore {
	findAllIds(): Promise<Set<string>>;
}

/** A table pruned by age, returning how many rows went. */
export interface WorkerRetentionStore {
	pruneOlderThan(cutoff: Date): Promise<number>;
}

export interface WorkerServices {
	adminFailureNotifications: { notifyWorkerFailed(workerId: string, errorText: string | null): void };
	adminLogs: { purgeOldLogs(retentionDays: undefined, context: undefined, signal: AbortSignal): Promise<{ deletedCount: number }> };
	databaseBackup: { createBackup(): Promise<{ fileName: string; sizeBytes: number }> };
	updateNotifications: { notifyIfUpdateAvailable(forceCheck: boolean): Promise<boolean> };
	mediaAudit: {
		buildReport(): Promise<MediaFileAuditResponse>;
		isSuspect(mediaFileId: string): Promise<boolean>;
	};
	mediaFileRefresh: { queue(mediaFileId: string, options?: TaskSchedulingOptions): Promise<unknown> };
	metadataRefresh: {
		refresh(
			metadataId: string,
			options: { correlationId?: string | undefined; operationId?: string | undefined; signal?: AbortSignal | undefined },
		): Promise<MetadataRefreshResult>;
	};
	metadataProcess: MetadataMatcher;
	pluginBlobs: { purgeExpired(signal?: AbortSignal): Promise<void> };
	pluginMedia: { get(mediaFileId: string): Promise<PluginMediaFile | null> };
	pluginRegistry: { analyzeMedia(media: PluginMediaFile): Promise<MediaAnalysis> };
}

/** Everything a worker reads or writes outside the runtime. Filled at startup by the app wiring. */
export interface WorkerDependencies {
	jobs: WorkerJobStore;
	operations: WorkerOperationStore;
	schedules: WorkerScheduleStore;
	media: WorkerMediaFileStore;
	libraries: WorkerLibraryStore;
	mediaMarkers: WorkerMediaMarkerStore;
	scanFindings: WorkerScanFindingsStore;
	scanState: WorkerScanStateStore;
	subtitles: WorkerSubtitleStore;
	adminAudit: WorkerRetentionStore;
	interruptedPlayback: WorkerRetentionStore;
	watchedHistory: WorkerRetentionStore;
	resourceMetrics: { cleanupOlderThan(cutoff: Date): Promise<number> };
	services: WorkerServices;
}

let dependencies: WorkerDependencies | undefined;

export function wireWorkerDependencies(deps: WorkerDependencies): void {
	dependencies = deps;
}

export function workerDependencies(): WorkerDependencies {
	if (!dependencies) {
		throw new DomainError("internal", "Worker dependencies are not wired", { code: "workers.port_not_wired" });
	}

	return dependencies;
}
