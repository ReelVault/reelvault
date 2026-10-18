import type { PlaybackArtifact, PlaybackArtifactWrite } from "@reelvault/sdk/common";
import { DomainError } from "@/utils/domain.errors";

/** The media file fields the preview generator reads: where it is, and how long it runs. */
export interface TrickplaySource {
	filePath: string | null;
	duration: number | null;
}

/**
 * Storage the preview generator reads and writes through. The application layer
 * registers an implementation at startup, so this module never imports the database.
 */
export interface TrickplayStoragePort {
	findSource(mediaFileId: string): Promise<TrickplaySource | undefined>;
	/** Writes a core-budgeted artifact; rejects with the budget error when the write does not fit. */
	writeArtifact(artifact: PlaybackArtifactWrite): Promise<PlaybackArtifact>;
	/** Removes the core previews of one media file and returns how many artifacts were removed. */
	removePreviews(mediaFileId: string): Promise<number>;
	storedBytes(): Promise<number>;
	mediaFileStoredBytes(mediaFileId: string): Promise<number>;
}

let storagePort: TrickplayStoragePort | undefined;

export function wireTrickplayStorage(port: TrickplayStoragePort): void {
	storagePort = port;
}

export function trickplayStorage(): TrickplayStoragePort {
	if (!storagePort) {
		throw new DomainError("internal", "Trickplay storage port is not wired", { code: "trickplay.port_not_wired" });
	}

	return storagePort;
}
