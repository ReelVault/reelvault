import type { PluginAccessContext, PluginAccessDenial } from "@reelvault/sdk/plugin";
import type { SessionSelectionInput } from "@/modules/streaming/decisions/session-selection.resolver";
import type { DiagnosticsMediaFile } from "@/modules/streaming/diagnostics/diagnostics.service";
import type { StreamInitData } from "@/modules/streaming/runtime/stream.initializer";
import { DomainError } from "@/utils/domain.errors";

/** A media file as playback session selection reads it. */
export type StreamingPlaybackFile = SessionSelectionInput["file"] & { id: string; filePath: string; isEnabled: boolean };

/** Active-session media labels for the remote-control views. */
export interface StreamingMediaSummary {
	mediaFileId: string;
	metadataId: string;
	title: string | null;
	type: string | null;
	posterImageId: string | null;
	posterImageUpdatedAt: Date | null;
}

export interface StreamingSessionProgress {
	completed: boolean;
	position: number | null;
	audioStreamIndex: number | null;
	subtitleId: string | null;
}

/** Everything a session start reads about one file and viewer, in one statement. */
export interface StreamingPlaybackSessionData {
	file: StreamingPlaybackFile;
	existingProgress?: StreamingSessionProgress | undefined;
	/** Whether any file of the title has in-progress playback past the resume threshold. */
	titleHasActiveProgress: boolean;
	perTitlePreferences: NonNullable<SessionSelectionInput["perTitlePreferences"]> | null;
}

export interface InterruptedPlaybackRecord {
	profileId: string;
	mediaFileId: string;
	startedAt: Date;
	endedAt: Date;
	playedSeconds: number;
	furthestPositionSeconds: number;
	durationSeconds: number | null | undefined;
	reason: string;
}

/**
 * Data streaming reads and writes outside the module. The application layer
 * registers an implementation at startup, so this module never imports the database.
 */
export interface StreamingStoragePort {
	findMediaSummaries(mediaFileIds: string[]): Promise<StreamingMediaSummary[]>;
	markStreamAttached(operationId: string): Promise<boolean>;
	updateOperationProgress(operationId: string, progressPercent: number): Promise<void>;
	completeStreamOperation(operationId: string): Promise<void>;
	releaseStreamOperation(operationId: string): Promise<void>;
	/** Of the given operation ids, the ones that are still queued or running. */
	findActiveOperations(operationIds: string[]): Promise<Set<string>>;
	recordInterruptedSession(record: InterruptedPlaybackRecord): Promise<void>;
	findPlaybackSessionData(
		mediaFileId: string,
		profileId: string,
		thresholdSeconds: number,
	): Promise<StreamingPlaybackSessionData | undefined>;
	findForStreamingDiagnostics(mediaFileId: string): Promise<DiagnosticsMediaFile | null | undefined>;
	findForStreamingDuration(mediaFileId: string): Promise<{ duration: number | null } | undefined>;
	getEffectivePreferences(profileId: string): Promise<SessionSelectionInput["preferences"]>;
}

let storagePort: StreamingStoragePort | undefined;

export function wireStreamingStorage(port: StreamingStoragePort): void {
	storagePort = port;
}

export function streamingStorage(): StreamingStoragePort {
	if (!storagePort) {
		throw new DomainError("internal", "Streaming storage port is not wired", { code: "streaming.port_not_wired" });
	}

	return storagePort;
}

/** Worker runtime operations the streaming engine starts, stops and tracks. Registered by the app at startup. */
export interface StreamingWorkerPort {
	cancelOperation(operationId: string): Promise<boolean>;
	createOperation(input: { type: string; reference?: { type: string; id: string } }): Promise<{ id: string }>;
	removeOperation(id: string): Promise<void>;
	enqueueStreamInit(data: StreamInitData, options?: { operationId?: string | undefined }): Promise<{ operationId?: string | null }>;
}

/** Plugin access policies consulted before a stream is served. */
export interface StreamAccessPolicyPort {
	check(context: PluginAccessContext): Promise<PluginAccessDenial | undefined>;
}

let workerPort: StreamingWorkerPort | undefined;
let accessPolicyPort: StreamAccessPolicyPort | undefined;

export function wireStreamingWorker(port: StreamingWorkerPort): void {
	workerPort = port;
}

export function streamingWorker(): StreamingWorkerPort {
	if (!workerPort) {
		throw new DomainError("internal", "Streaming worker port is not wired", { code: "streaming.worker_port_not_wired" });
	}

	return workerPort;
}

export function wireStreamAccessPolicy(port: StreamAccessPolicyPort): void {
	accessPolicyPort = port;
}

export function streamAccessPolicy(): StreamAccessPolicyPort {
	if (!accessPolicyPort) {
		throw new DomainError("internal", "Stream access policy port is not wired", { code: "streaming.access_policy_port_not_wired" });
	}

	return accessPolicyPort;
}
