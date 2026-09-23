export interface OfflineRebuildIssue {
	readonly path: string;
	readonly reason: string;
}

export interface OfflineRebuildReport {
	readonly importedMovies: number;
	readonly importedMediaFiles: number;
	readonly skipped: readonly OfflineRebuildIssue[];
}

export interface CatalogImportResult {
	readonly entries: number;
	readonly mediaFiles: number;
}
