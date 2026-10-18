import type { MetadataStorageMode } from "@reelvault/sdk/common";
import { DomainError } from "@/utils/domain.errors";
import type { SidecarFlavor, SidecarSnapshotResolver } from "./sidecar.types";

export interface SidecarStorageLibrary {
	metadataStorageMode: MetadataStorageMode;
	/** Target NFO dialect; libraries predate the field, so treat missing as the native flavor. */
	sidecarFlavor?: SidecarFlavor | null;
	paths: Array<{ path: string; metadataStorageMode: MetadataStorageMode | null }>;
}

export interface SidecarStorageMediaFile {
	filePath: string;
	metadataId: string;
	movieId: string | null;
	episodeId: string | null;
}

export interface SidecarRootMediaFile extends SidecarStorageMediaFile {
	libraryId: string;
}

export interface SidecarEpisodeRecord {
	id: string;
	seasonId: string;
	title?: string | null | undefined;
	episodeNumber: number;
	airDate?: string | null | undefined;
	overview?: string | null | undefined;
	imageId?: string | null | undefined;
}

export interface SidecarSeasonRecord {
	id: string;
	seasonNumber: number;
	name?: string | null | undefined;
	airDate?: string | null | undefined;
	overview?: string | null | undefined;
	status?: string | null | undefined;
	imageId?: string | null | undefined;
}

/**
 * Data the sidecar engine reads and writes outside the module. The application
 * layer registers an implementation at startup, so this module never imports the database.
 */
export interface SidecarStoragePort {
	findEpisodeRecords(ids: string[]): Promise<SidecarEpisodeRecord[]>;
	findSeasonRecords(ids: string[]): Promise<SidecarSeasonRecord[]>;
	findRootMediaFiles(metadataId: string): Promise<SidecarRootMediaFile[]>;
	findLibraryWithPaths(libraryId: string): Promise<SidecarStorageLibrary | undefined>;
	findLibraryPaths(libraryId: string): Promise<{ paths: Array<{ path: string }> } | undefined>;
	/** Releases the handle of a database file this module rewrote on disk. */
	shutdownDatabaseFile(databasePath: string): void;
}

let storagePort: SidecarStoragePort | undefined;
let snapshotPort: SidecarSnapshotResolver | undefined;

export function wireSidecarStorage(port: SidecarStoragePort): void {
	storagePort = port;
}

export function sidecarStorage(): SidecarStoragePort {
	if (!storagePort) {
		throw new DomainError("internal", "Sidecar storage port is not wired", { code: "sidecars.port_not_wired" });
	}

	return storagePort;
}

export function wireSidecarSnapshots(resolver: SidecarSnapshotResolver): void {
	snapshotPort = resolver;
}

export function sidecarSnapshots(): SidecarSnapshotResolver {
	if (!snapshotPort) {
		throw new DomainError("internal", "Sidecar snapshot port is not wired", { code: "sidecars.snapshots_not_wired" });
	}

	return snapshotPort;
}
