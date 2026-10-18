import type { CreateMediaFile, LibraryWithRelations } from "@reelvault/sdk/common";
import type { PluginEventInput } from "@reelvault/sdk/plugin";
import type { ScanFindingReason } from "@/integrations/drizzle-orm/constants/scan-findings.constants";
import type { ProcessRunOptions } from "@/modules/scanner/processing/media-file.processor";
import type { ProcessedMediaFileWithMarkers, SkippedMediaFile } from "@/modules/scanner/scanner.types";
import type { ApplicationContext, TaskSchedulingOptions } from "@/utils/task-context.types";
import type { MediaFileAnalysisData } from "@/workers/definitions/media/media-file-analysis.worker";

export interface MediaFileIngestData {
	libraryId: string;
	libraryType: "movie" | "tv_show";
	filePath: string;
}

export interface MediaFileIngestResult {
	libraryId: string;
	filePath: string;
	mediaFileId: string | null;
	created: boolean;
	skipReason?: ScanFindingReason | undefined;
	analysisTaskId?: string | undefined;
}

export interface MediaFileIngestOrchestration {
	operationId?: string | undefined;
	taskId?: string | undefined;
	attempt?: number | undefined;
}

export interface MediaFileIngestTaskDependencies {
	findLibrary(libraryId: string): Promise<LibraryWithRelations | undefined>;
	processFile(
		libraryType: "movie" | "tv_show",
		filePath: string,
		skipExistingLookup: boolean,
		options?: ProcessRunOptions,
	): Promise<ProcessedMediaFileWithMarkers | SkippedMediaFile | null>;
	upsertScanFinding(finding: { libraryId: string; filePath: string; fileName: string; reason: ScanFindingReason }): Promise<void>;
	deleteScanFinding(libraryId: string, filePath: string): Promise<void>;
	createMediaFile(data: CreateMediaFile): Promise<{ mediaFile: { id: string }; created: boolean }>;
	importSidecarSubtitles?(mediaFileId: string, videoFilePath: string): Promise<number>;
	findMediaByPaths(
		libraryId: string,
		filePaths: string[],
	): Promise<Array<{ filePath: string; metadataId: string; movieId: string | null; episodeId: string | null }>>;
	saveSidecars(
		library: LibraryWithRelations,
		mediaFiles: Array<{ filePath: string; metadataId: string; movieId: string | null; episodeId: string | null }>,
	): Promise<void>;
	emitMediaDiscovered(input: PluginEventInput<"media.file.discovered">): Promise<void>;
	emitMediaIdentified(input: PluginEventInput<"media.file.identified">): Promise<void>;
	/** Which post-create side effects already ran (used by the retry path). */
	readIngestProgress?(mediaFileId: string): Promise<{ sidecarWritten: boolean; discoveredEmitted: boolean }>;
	markSidecarWritten?(mediaFileId: string): Promise<void>;
	markDiscoveredEmitted?(mediaFileId: string): Promise<void>;
	enqueueAnalysis(data: MediaFileAnalysisData, options?: TaskSchedulingOptions): Promise<{ id: string }>;
	enqueueTrickplayGeneration(mediaFileId: string, libraryId: string): Promise<unknown>;
}

/** Identity of one media-file row owned by the ingested file; a range file owns several. */
export interface IngestTarget {
	mediaFileId: string;
	metadataId: string;
	movieId: string | null;
	episodeId: string | null;
}

/** State needed to finish an ingest after the media-file row exists. */
export interface IngestCompletionInput {
	data: MediaFileIngestData;
	library: LibraryWithRelations;
	target: IngestTarget;
	context: ApplicationContext;
	orchestration: MediaFileIngestOrchestration;
	taskScheduling: TaskSchedulingOptions;
}
