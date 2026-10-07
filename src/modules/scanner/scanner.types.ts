import type { CreateMediaFile } from "@reelvault/sdk/common";
import type { ChapterMarkerDraft } from "./probe/chapters-to-markers.utils";

export type LibraryType = "movie" | "tv_show";

export type ScanFindingReason = "recognition_failed" | "type_mismatch" | "no_metadata_match";

/** A file the scan could not turn into a media file — recorded for the admin "needs attention" view. */
export interface SkippedMediaFile {
	skipReason: ScanFindingReason;
	fileName: string;
}

export type ProcessedMediaFile = Omit<CreateMediaFile, "libraryId">;

/** Identity of an additional episode covered by a multi-episode file (S01E01-E02). */
export interface AdditionalEpisodeTarget {
	metadataId: string;
	movieId: string | null;
	episodeId: string;
}

/** Processed file enriched with chapter-derived markers — NOT part of CreateMediaFile. */
export interface ProcessedMediaFileWithMarkers extends ProcessedMediaFile {
	automaticMarkers?: ChapterMarkerDraft[];
	/** Remaining episodes of a range file — each gets its own media-file row sharing the same physical file. */
	additionalTargets?: AdditionalEpisodeTarget[];
}

export interface LibraryScanResult {
	filePaths: string[];
	newFilePaths: string[];
	changedMediaFileIds: string[];
}
