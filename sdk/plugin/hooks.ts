import type { CatalogMediaType, MetadataCandidate, PlaybackArtifactKind } from "../common";

export interface MediaRecognitionCandidate {
	type: CatalogMediaType;
	title: string;
	year?: number | undefined;
	season?: number | undefined;
	episode?: number | undefined;
}

export interface BeforeMediaRecognitionContext {
	readonly candidate: Readonly<MediaRecognitionCandidate>;
}

export type BeforeMediaRecognitionHook = (
	context: BeforeMediaRecognitionContext,
) => MediaRecognitionCandidate | undefined | Promise<MediaRecognitionCandidate | undefined>;

export interface ArtifactCreationCandidate {
	mediaFileId: string;
	kind: PlaybackArtifactKind;
	contentType: string;
	size: number;
}

export interface BeforeArtifactCreateContext {
	readonly candidate: Readonly<ArtifactCreationCandidate>;
}

export type BeforeArtifactCreateHook = (
	context: BeforeArtifactCreateContext,
) => ArtifactCreationCandidate | undefined | Promise<ArtifactCreationCandidate | undefined>;

export interface BeforeMetadataSaveContext {
	readonly candidate: Readonly<MetadataCandidate>;
}

export type BeforeMetadataSaveHook = (
	context: BeforeMetadataSaveContext,
) => MetadataCandidate | undefined | Promise<MetadataCandidate | undefined>;

export interface PluginHooks {
	beforeArtifactCreate(handler: BeforeArtifactCreateHook): void;
	beforeMediaRecognition(handler: BeforeMediaRecognitionHook): void;
	beforeMetadataSave(handler: BeforeMetadataSaveHook): void;
}

/** Deliberately stops the current metadata import without treating it as a plugin failure. */
export class PluginHookRejection extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PluginHookRejection";
	}
}

export function rejectPluginHook(message: string): never {
	throw new PluginHookRejection(message);
}
