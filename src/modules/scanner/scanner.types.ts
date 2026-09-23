import type { CreateMediaFile } from "@sdk/common/media-file.types";
import type { ChapterMarkerDraft } from "./probe/chapters-to-markers.utils";

export type LibraryType = "movie" | "tv_show";

export type ScanFindingReason = "recognition_failed" | "type_mismatch" | "no_metadata_match";

/** A file the scan could not turn into a media file — recorded for the admin "needs attention" view. */
export interface SkippedMediaFile {
	skipReason: ScanFindingReason;
	fileName: string;
}

export type ProcessedMediaFile = Omit<CreateMediaFile, "libraryId">;

/** Processed file enriched with chapter-derived markers — NOT part of CreateMediaFile. */
export interface ProcessedMediaFileWithMarkers extends ProcessedMediaFile {
	automaticMarkers?: ChapterMarkerDraft[];
}

export interface LibraryScanResult {
	filePaths: string[];
	newFilePaths: string[];
	changedMediaFileIds: string[];
}

export interface FilePathChanges {
	newFiles: string[];
	removedFiles: string[];
}
