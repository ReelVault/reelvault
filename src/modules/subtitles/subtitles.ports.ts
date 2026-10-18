import type {
	CreateSubtitleRequest,
	PaginatedResponse,
	PaginationQuery,
	SubtitleEntity,
	SubtitleFilters,
	SubtitleProviderDownloadRequest,
	SubtitleProviderSearchRequest,
	SubtitleProviderSearchResponse,
	SubtitleProviderStatus,
	SubtitleSorting,
	SubtitleType,
	UpdateSubtitleRequest,
} from "@reelvault/sdk/common";
import { DomainError } from "@/utils/domain.errors";

/** A sidecar subtitle file found next to a video, stored as an external subtitle row. */
export interface ExternalSubtitleInsert {
	mediaFileId: string;
	language: string;
	format: string;
	filePath: string;
	type: "external";
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired: boolean;
}

/**
 * Data subtitles read and write outside the module. The application layer
 * registers an implementation at startup, so this module never imports the database.
 */
export interface SubtitlesStoragePort {
	findPage(query?: PaginationQuery & SubtitleFilters & SubtitleSorting): Promise<PaginatedResponse<SubtitleEntity>>;
	findByMediaFileId(mediaFileId: string): Promise<SubtitleEntity[]>;
	findById(id: string): Promise<SubtitleEntity | null | undefined>;
	createRow(body: CreateSubtitleRequest, type: SubtitleType): Promise<SubtitleEntity | null | undefined>;
	updateRow(id: string, body: UpdateSubtitleRequest): Promise<SubtitleEntity | null | undefined>;
	deleteRow(id: string): Promise<SubtitleEntity | null | undefined>;
	/** Path of the media file a subtitle is extracted from, or null when the file is gone. */
	findMediaFilePath(mediaFileId: string): Promise<string | null | undefined>;
	/** Languages that already have an external subtitle for this media file. */
	findExternalLanguages(mediaFileId: string): Promise<Set<string>>;
	/** Inserts external subtitle rows, skipping ones that already exist; returns how many were inserted. */
	insertExternal(values: ExternalSubtitleInsert[]): Promise<number>;
}

let storagePort: SubtitlesStoragePort | undefined;

export function wireSubtitlesStorage(port: SubtitlesStoragePort): void {
	storagePort = port;
}

export function subtitlesStorage(): SubtitlesStoragePort {
	if (!storagePort) {
		throw new DomainError("internal", "Subtitles storage port is not wired", { code: "subtitles.port_not_wired" });
	}

	return storagePort;
}

/** Subtitle providers supplied by plugins. The app registers the implementation at startup. */
export interface SubtitleProvidersPort {
	getProviderStatus(): SubtitleProviderStatus[];
	search(request: SubtitleProviderSearchRequest): Promise<SubtitleProviderSearchResponse[]>;
	download(providerId: string, request: SubtitleProviderDownloadRequest): Promise<string>;
	disabledProviderIds(): Promise<Set<string>>;
	setEnabled(providerId: string, enabled: boolean): Promise<void>;
	getContent(subtitleId: string): Promise<{ contentType: string; file: Blob } | null>;
}

let providersPort: SubtitleProvidersPort | undefined;

export function wireSubtitleProviders(port: SubtitleProvidersPort): void {
	providersPort = port;
}

export function subtitleProviders(): SubtitleProvidersPort {
	if (!providersPort) {
		throw new DomainError("internal", "Subtitle providers port is not wired", { code: "subtitles.providers_port_not_wired" });
	}

	return providersPort;
}
