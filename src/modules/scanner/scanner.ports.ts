import { DomainError } from "@/utils/domain.errors";

/** What deleting library files reports back: the rows removed and the storage they owned. */
export interface LibraryFilesCleanup {
	removedMediaFiles: ReadonlyArray<{ id: string }>;
	artifactStorageKeys: string[];
	subtitleFilePaths: ReadonlyArray<string | null | undefined>;
	subtitleIds: readonly string[];
}

/** One media file row a library scan compares against the disk. */
export interface ScanStatsRow {
	id: string;
	filePath: string;
	size: number | null;
	sourceMtimeMs: number | null;
}

/**
 * Data the scanner reads and writes outside its own engine. The application layer
 * registers an implementation at startup, so this module never imports the database.
 */
export interface ScannerStoragePort {
	deleteByLibraryAndPaths(libraryId: string, filePaths: string[]): Promise<LibraryFilesCleanup>;
	removeArtifactStorageFiles(keys: string[]): Promise<unknown>;
	invalidateArtifactByteTotals(): void;
	clearLibraryStatsCache(): void;
	findStatsPage(libraryId: string, cursor: string | undefined, limit: number): Promise<ScanStatsRow[]>;
	findIdByFilePath(filePath: string): Promise<{ id: string } | undefined>;
	optimizeDatabase(): void;
}

let storagePort: ScannerStoragePort | undefined;

export function wireScannerStorage(port: ScannerStoragePort): void {
	storagePort = port;
}

export function scannerStorage(): ScannerStoragePort {
	if (!storagePort) {
		throw new DomainError("internal", "Scanner storage port is not wired", { code: "scanner.port_not_wired" });
	}

	return storagePort;
}
