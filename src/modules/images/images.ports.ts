import { DomainError } from "@/utils/domain.errors";

export interface ImageProcess {
	url?: string | undefined;
	type: "poster" | "backdrop";
}

export interface PersistedImageInput {
	localPath: string;
	contentType: string;
	width: number;
	height: number;
	fileSize: number;
	sourceHash: string;
	stableKey: string;
}

export interface ImageOwnerTarget {
	ownerStableKey: string;
	currentLocalPath?: string | undefined;
}

/** An image row the optimization sweep may rewrite. */
export interface ImageOptimizationCandidate {
	id: string;
	localPath: string;
	width: number | null;
	height: number | null;
}

export interface ImageOptimizationValues {
	width?: number | null;
	height?: number | null;
	fileSize?: number | null;
}

/**
 * Data images read and write outside the module. The application layer registers
 * an implementation at startup, so this module never imports the database.
 */
export interface ImagesStoragePort {
	findForFileRead(imageId: string): Promise<{ localPath: string; contentType: string } | undefined>;
	deleteAndReturn(imageId: string): Promise<{ localPath: string } | undefined>;
	findMetadataImagePath(metadataId: string, imageType: ImageProcess["type"]): Promise<string | undefined>;
	findAllImageStorageIdentifiers(): Promise<{ localPaths: Set<string>; imageIds: Set<string> }>;
	findOutdatedImageIds(currentVersion: number): Promise<string[]>;
	findImageOptimizationCandidate(imageId: string, currentVersion: number): Promise<ImageOptimizationCandidate | undefined>;
	markImageOptimizationVersion(imageId: string, currentVersion: number, values?: ImageOptimizationValues): Promise<void>;
	getMetadataTarget(metadataId: string, type: ImageProcess["type"]): Promise<ImageOwnerTarget>;
	replaceMetadataImage(metadataId: string, type: ImageProcess["type"], image: PersistedImageInput): Promise<void>;
	getSeasonTarget(metadataId: string, seasonId: string): Promise<ImageOwnerTarget>;
	replaceSeasonImage(metadataId: string, seasonId: string, image: PersistedImageInput): Promise<void>;
	getEpisodeTarget(metadataId: string, episodeId: string): Promise<ImageOwnerTarget>;
	replaceEpisodeImage(metadataId: string, episodeId: string, image: PersistedImageInput): Promise<void>;
	getPersonTarget(personId: string): Promise<ImageOwnerTarget>;
	replacePersonImage(personId: string, image: PersistedImageInput): Promise<void>;
	getProfileAvatarTarget(profileId: string): Promise<ImageOwnerTarget>;
	replaceProfileAvatar(profileId: string, image: PersistedImageInput): Promise<{ imageId: string; avatarUrl: string }>;
}

let storagePort: ImagesStoragePort | undefined;

export function wireImagesStorage(port: ImagesStoragePort): void {
	storagePort = port;
}

export function imagesStorage(): ImagesStoragePort {
	if (!storagePort) {
		throw new DomainError("internal", "Images storage port is not wired", { code: "images.port_not_wired" });
	}

	return storagePort;
}
