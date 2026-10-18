import type { DownloadQuality, DownloadStatus } from "@/integrations/drizzle-orm/constants/downloads.constants";
import { DomainError } from "@/utils/domain.errors";

export interface DownloadRecord {
	id: string;
	profileId: string;
	mediaFileId: string;
	quality: DownloadQuality;
	status: DownloadStatus;
	progressPercent: number;
	sizeBytes: number | null;
	fileName: string | null;
	errorText: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface DownloadInsert {
	profileId: string;
	mediaFileId: string;
	quality: DownloadQuality;
}

export interface DownloadUpdate {
	status?: DownloadStatus;
	progressPercent?: number;
	sizeBytes?: number | null;
	fileName?: string | null;
	errorText?: string | null;
}

/** The media file fields a download reads: where it lives, its length and its name. */
export interface DownloadMediaFile {
	id: string;
	filePath: string;
	duration?: number | null | undefined;
	fileName: string;
}

export interface DownloadMediaIdentity {
	id: string;
	metadataId: string;
}

export interface DownloadSeason {
	id: string;
	metadataId: string;
}

/** One episode of a metadata entry with the media file a season download would take for it. */
export interface DownloadEpisodeFile {
	id: string;
	seasonId: string;
	mediaFileId: string | null;
	mediaFileIsDefault: boolean | null;
	mediaFileSize: number | null;
}

/**
 * Data downloads read and write outside the module. The application layer
 * registers an implementation at startup, so this module never imports the database.
 */
export interface DownloadsStoragePort {
	insert(values: DownloadInsert): Promise<DownloadRecord>;
	findById(id: string): Promise<DownloadRecord | undefined>;
	findByProfile(profileId: string): Promise<DownloadRecord[]>;
	findPage(query: {
		status?: DownloadStatus | undefined;
		limit: number;
		offset: number;
	}): Promise<{ data: DownloadRecord[]; total: number }>;
	countByStatus(): Promise<Record<DownloadStatus, number>>;
	findExistingIds(ids: readonly string[]): Promise<Set<string>>;
	findByStatuses(statuses: readonly DownloadStatus[]): Promise<DownloadRecord[]>;
	findExpired(retentionDays: number): Promise<DownloadRecord[]>;
	storageUsedByProfile(profileId: string): Promise<number>;
	countProcessingByProfile(profileId: string): Promise<number>;
	countPendingByProfile(profileId: string): Promise<number>;
	hasActiveByProfileAndMedia(profileId: string, mediaFileId: string): Promise<boolean>;
	findPendingByProfile(profileId: string, limit: number): Promise<DownloadRecord[]>;
	claimForProcessing(id: string, profileId: string, maxRunning: number): Promise<boolean>;
	update(id: string, values: DownloadUpdate): Promise<void>;
	delete(id: string): Promise<void>;
	findMediaFileForDownload(mediaFileId: string): Promise<DownloadMediaFile | undefined>;
	findMediaIdentities(mediaFileIds: readonly string[]): Promise<DownloadMediaIdentity[]>;
	findSeasonForDownload(seasonId: string): Promise<DownloadSeason | undefined>;
	findEpisodeFilesByMetadataId(metadataId: string): Promise<DownloadEpisodeFile[]>;
}

let storagePort: DownloadsStoragePort | undefined;

export function wireDownloadsStorage(port: DownloadsStoragePort): void {
	storagePort = port;
}

export function downloadsStorage(): DownloadsStoragePort {
	if (!storagePort) {
		throw new DomainError("internal", "Downloads storage port is not wired", { code: "downloads.port_not_wired" });
	}

	return storagePort;
}

/** Queues the background processing of one download. The worker runtime is registered by the app at startup. */
export interface DownloadsProcessPort {
	enqueueProcess(downloadId: string): Promise<unknown>;
}

let processPort: DownloadsProcessPort | undefined;

export function wireDownloadsProcess(port: DownloadsProcessPort): void {
	processPort = port;
}

export function downloadsProcess(): DownloadsProcessPort {
	if (!processPort) {
		throw new DomainError("internal", "Downloads process port is not wired", { code: "downloads.process_port_not_wired" });
	}

	return processPort;
}
