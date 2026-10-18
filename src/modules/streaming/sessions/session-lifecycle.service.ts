import type { CreatePlaybackSession, PlaybackDecision, PlaybackSession } from "@reelvault/sdk/common";
import { serverConstants } from "@/config/server/server.constants";
import { systemSettingsStore } from "@/config/system-settings.store";
import { assertFFMpegAvailable } from "@/integrations/ffmpeg/ffmpeg.environment";
import { resolveSessionSelection, type SessionSelectionInput } from "@/modules/streaming/decisions/session-selection.resolver";
import type { SessionAccessInfo } from "@/modules/streaming/runtime/session-state/session.store";
import type { StreamInitData } from "@/modules/streaming/runtime/stream.initializer";
import { streamingManager as streamingRuntimeService } from "@/modules/streaming/runtime/streaming.manager";
import { type StreamingProgressSnapshot, streamingStorage, streamingWorker } from "@/modules/streaming/streaming.ports";
import type { PlaybackSessionInput, SessionReleaseOutcome, TerminatedSessionEntry } from "@/modules/streaming/streaming.types";
import { assertFound, DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { detach } from "@/utils/promise.utils";
import { runSafely } from "@/utils/safe-execute.utils";
import { PlaybackSessionIdempotencyRegistry } from "./playback-session.registry";
import { SessionCreationGuard } from "./session-creation.guard";
import { type PlaybackSessionStartedEvent, publishSessionStarted } from "./session-events.publisher";
import { findSameTitleSession } from "./session-reclaim.resolver";
import { assertSafeId, parseCapabilities, toPlaybackSessionInput } from "./session-request.mapper";
import { isAdminTerminationReason, resolveSessionAccess } from "./stream-access.guard";

export type PlaybackSessionCandidate = SessionSelectionInput["file"] & {
	id: string;
	filePath: string;
	isEnabled: boolean;
};

export interface SessionLifecycleRuntime {
	isProfileTerminatedRecently(profileId: string, mediaFileId: string, windowMs?: number): { reason: string } | null;
	getActiveSessions(): number;
	getSessionAccess(sessionId: string): SessionAccessInfo | undefined;
	releaseSession(sessionId: string, reason: string): Promise<SessionReleaseOutcome>;
	listSessionsForProfile(profileId: string): Array<{ sessionId: string; mediaFileId: string }>;
	getTerminatedSession(sessionId: string): TerminatedSessionEntry | undefined;
	reserveSession(sessionId: string, userId?: string): boolean;
	explainCapacityLimit(userId?: string): { scope: "user" | "server"; limit: number; active: number };
	registerSession(
		sessionId: string,
		data: { mediaFileId: string; profileId: string; decision: PlaybackDecision; inputPath: string; durationMs?: number | null },
	): void;
	prepareSession(sessionId: string): Promise<void>;
	setSessionOperation(sessionId: string, operationId: string): void;
	releaseSessionReservation(sessionId: string): void;
	discardSession(sessionId: string): Promise<void>;
}

export interface ServiceDependencies {
	mediaRepository: {
		findForPlaybackSession(mediaFileId: string): Promise<PlaybackSessionCandidate | null | undefined>;
	};
	profilePreferencesRepository: {
		getEffective(input: { profileId: string }): Promise<SessionSelectionInput["preferences"]>;
	};
	profileStreamPrefsRepository: {
		findForTitle(profileId: string, metadataId: string): Promise<SessionSelectionInput["perTitlePreferences"] | undefined>;
	};
	playbackRepository: {
		findProgressUpdateData(fileId: string, profileId: string): Promise<StreamingProgressSnapshot>;
		hasActiveTitleProgress(profileId: string, metadataId: string, thresholdSeconds: number): Promise<boolean>;
	};
	systemSettings: Pick<typeof systemSettingsStore, "get">;
	workerService: {
		createOperation(input: { type: string; reference?: { type: string; id: string } }): Promise<{ id: string }>;
		removeOperation(id: string): Promise<void> | void;
	};
	enqueueStreamInit: (data: StreamInitData, options?: { operationId?: string | undefined }) => Promise<{ operationId?: string | null }>;
	runtime: SessionLifecycleRuntime;
	publisher: (event: PlaybackSessionStartedEvent) => void;
	assertEnvironment: typeof assertFFMpegAvailable;
}

const defaultDependencies: ServiceDependencies = {
	mediaRepository: {
		findForPlaybackSession: (mediaFileId) => streamingStorage().findForPlaybackSession(mediaFileId),
	},
	profilePreferencesRepository: {
		getEffective: (input) => streamingStorage().getEffectivePreferences(input.profileId),
	},
	profileStreamPrefsRepository: {
		findForTitle: (profileId, metadataId) => streamingStorage().findStreamPreferences({ profileId, metadataId }),
	},
	playbackRepository: {
		findProgressUpdateData: (fileId, profileId) => streamingStorage().findProgressUpdateData(fileId, profileId),
		hasActiveTitleProgress: (profileId, metadataId, thresholdSeconds) =>
			streamingStorage().hasActiveTitleProgress(profileId, metadataId, thresholdSeconds),
	},
	systemSettings: systemSettingsStore,
	workerService: {
		createOperation: (input) => streamingWorker().createOperation(input),
		removeOperation: (id) => streamingWorker().removeOperation(id),
	},
	enqueueStreamInit: (data, options) => streamingWorker().enqueueStreamInit(data, options),
	runtime: streamingRuntimeService,
	publisher: publishSessionStarted,
	assertEnvironment: assertFFMpegAvailable,
};

export class SessionLifecycleService {
	readonly serviceName = "SessionLifecycleService";
	readonly logger = createLogger("SessionLifecycleService");

	private readonly playbackSessionIdempotency = new PlaybackSessionIdempotencyRegistry<PlaybackSession>();
	private readonly creationGuard = new SessionCreationGuard();
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		this.dependencies = dependencies;
	}

	async createPlaybackSession(
		body: CreatePlaybackSession,
		profileId: string | undefined,
		idempotencyKey: string,
		userId?: string,
	): Promise<PlaybackSession> {
		if (!profileId)
			throw new DomainError("unauthorized", "An active profile is required to create a streaming session", {
				code: "auth.profile_required",
			});

		const recentTermination = this.dependencies.runtime.isProfileTerminatedRecently(profileId, body.mediaFileId, 20_000);
		if (recentTermination && isAdminTerminationReason(recentTermination.reason)) {
			throw new DomainError("forbidden", "Playback session was terminated", { code: "stream.session_terminated" });
		}

		return await this.playbackSessionIdempotency.execute(profileId, idempotencyKey, body, async () => {
			this.creationGuard.assertCooldown(profileId);

			return await this.createPlaybackSessionInternal(body.mediaFileId, toPlaybackSessionInput(body), profileId, userId);
		});
	}

	getActiveSessions(): number {
		return this.dependencies.runtime.getActiveSessions();
	}

	getSessionAccess(sessionId: string): SessionAccessInfo | undefined {
		assertSafeId(sessionId, "sessionId");

		return this.dependencies.runtime.getSessionAccess(sessionId);
	}

	releasePlaybackSession(sessionId: string): void {
		assertSafeId(sessionId, "sessionId");
		const release = this.dependencies.runtime.releaseSession(sessionId, "client-release");
		detach(
			(async () => {
				try {
					await release;
				} catch (error: unknown) {
					this.logger.error("Failed to release playback session", error, { sessionId });
				}
			})(),
		);
	}

	getTerminatedSession(sessionId: string): TerminatedSessionEntry | undefined {
		return this.dependencies.runtime.getTerminatedSession(sessionId);
	}

	requireSession(sessionId: string, label = "sessionId"): SessionAccessInfo {
		assertSafeId(sessionId, label);

		return resolveSessionAccess(
			sessionId,
			(id) => this.dependencies.runtime.getSessionAccess(id),
			(id) => this.dependencies.runtime.getTerminatedSession(id),
		);
	}

	/** Reserves the session's slot. At the limit, a same-title session of the profile may give up its slot first. */
	private async reserveSlot(sessionId: string, profileId: string, mediaFileId: string, userId?: string): Promise<void> {
		const { runtime } = this.dependencies;
		if (runtime.reserveSession(sessionId, userId)) return;
		if ((await this.reclaimSameTitleSession(profileId, mediaFileId)) && runtime.reserveSession(sessionId, userId)) return;

		const { scope, limit, active } = runtime.explainCapacityLimit(userId);
		throw new DomainError("too_many_requests", "Concurrent streaming session limit reached. Try again when another stream ends.", {
			code: "stream.limit_reached",
			params: { scope, limit, active, retryAfterSeconds: serverConstants.stream.sessionLimitRetryAfterSeconds },
		});
	}

	/** Ends every session the profile holds, for the close-all action on the remote-control page. Returns how many ended. */
	async releaseAllPlaybackSessions(profileId: string): Promise<number> {
		const { runtime } = this.dependencies;
		const sessions = runtime.listSessionsForProfile(profileId);
		await Promise.all(sessions.map((session) => runtime.releaseSession(session.sessionId, "client-release-all")));

		return sessions.length;
	}

	/**
	 * At the session limit, a profile that starts another version of a title it already streams gives up its older session's
	 * slot instead of being refused by its own session. Returns whether a session was ended.
	 */
	private async reclaimSameTitleSession(profileId: string, mediaFileId: string): Promise<boolean> {
		const { runtime } = this.dependencies;
		const profileSessions = runtime.listSessionsForProfile(profileId);
		if (profileSessions.length === 0) return false;

		const summaries = await streamingStorage().findMediaSummaries([mediaFileId, ...profileSessions.map((session) => session.mediaFileId)]);
		const titleOf = new Map(summaries.map((summary) => [summary.mediaFileId, summary.metadataId]));
		const older = findSameTitleSession(profileSessions, titleOf, mediaFileId);
		if (!older) return false;

		await runtime.releaseSession(older.sessionId, "superseded-by-same-title");

		return true;
	}

	private async createPlaybackSessionInternal(
		fileId: string,
		capabilitiesQuery: PlaybackSessionInput,
		profileId?: string,
		userId?: string,
	): Promise<PlaybackSession> {
		return await runSafely(this, "createPlaybackSession", async () => {
			const { workerService, enqueueStreamInit, runtime, publisher } = this.dependencies;
			this.dependencies.assertEnvironment();
			assertSafeId(fileId);
			if (!profileId)
				throw new DomainError("unauthorized", "An active profile is required to create a streaming session", {
					code: "auth.profile_required",
				});

			const { file, decision, videoCodec, audioStream, subtitle, playbackPreferences } = await this.selectPlayback(
				fileId,
				profileId,
				capabilitiesQuery,
			);

			this.logger.info(`Playback decision: ${decision.mode}`, {
				fileId,
				reason: decision.reason,
				videoTranscode: decision.videoTranscode,
				audioTranscode: decision.audioTranscode,
			});

			const sessionId = crypto.randomUUID();
			await this.reserveSlot(sessionId, profileId, file.id, userId);

			// One entity for the whole viewing: the decision/input are bound here and
			// every later seek restarts the process inside this session, never recreates it.
			let createdOperationId: string | undefined;
			let sessionOperationId: string;
			try {
				runtime.registerSession(sessionId, {
					mediaFileId: file.id,
					profileId,
					decision,
					inputPath: file.filePath,
					durationMs: file.duration != null ? file.duration * 1000 : null,
				});
				await runtime.prepareSession(sessionId);
				const operation = await workerService.createOperation({
					type: "streaming-session",
					reference: { type: "media-file", id: file.id },
				});
				createdOperationId = operation.id;
				const task = await enqueueStreamInit(
					{ sessionId, mediaFileId: file.id, filePath: file.filePath, decision },
					{ operationId: operation.id },
				);
				if (!task.operationId)
					throw new DomainError("internal", "Streaming operation was not attached to its task", { code: "stream.start_failed" });

				sessionOperationId = task.operationId;
				runtime.setSessionOperation(sessionId, task.operationId);

				publisher({
					sessionId,
					userId,
					profileId,
					mediaFileId: file.id,
					mode: decision.mode,
					videoCodec,
					audioCodec: audioStream?.codecName ?? null,
					videoBitrateKbps: decision.videoBitrateKbps ?? (file.bitRate ? Math.round(file.bitRate / 1000) : null),
					audioStreamIndex: audioStream?.index ?? null,
					startedAt: new Date().toISOString(),
				});

				return {
					operationId: sessionOperationId,
					mode: decision.mode,
					sessionId,
					reasons: decision.reasons ?? { video: { code: "unknown" }, audio: { code: "unknown" } },
					audioStreamIndex: audioStream?.index ?? null,
					subtitleLanguage: playbackPreferences.subtitleLanguage,
					subtitlesEnabled: playbackPreferences.subtitlesEnabled,
					forcedSubtitlesOnly: playbackPreferences.forcedSubtitlesOnly,
					subtitleId: subtitle?.id ?? null,
					subtitleStreamIndex: subtitle?.streamIndex ?? null,
					subtitleType: subtitle?.type ?? null,
					heartbeatIntervalMs: serverConstants.stream.heartbeatIntervalMs,
				};
			} catch (error) {
				if (createdOperationId) await workerService.removeOperation(createdOperationId);

				runtime.releaseSessionReservation(sessionId);
				await runtime.discardSession(sessionId);
				throw error;
			}
		});
	}

	/** Loads the file and the viewer's saved state, then picks the decision, codecs and tracks to play with. */
	private async selectPlayback(fileId: string, profileId: string, capabilitiesQuery: PlaybackSessionInput) {
		const { mediaRepository, profilePreferencesRepository, systemSettings } = this.dependencies;
		const [file, preferences, progressData] = await Promise.all([
			mediaRepository.findForPlaybackSession(fileId),
			profilePreferencesRepository.getEffective({ profileId }),
			this.dependencies.playbackRepository.findProgressUpdateData(fileId, profileId),
		]);
		assertFound(file, "MediaFile", fileId);

		if (!file.isEnabled) {
			throw new DomainError("forbidden", "This media file is disabled and cannot be played", { code: "media_file.disabled" });
		}

		const capabilities = parseCapabilities(capabilitiesQuery);
		const smartSelectionEnabled = systemSettings.get("stream.smartAudioTrackSelection");
		const thresholdSeconds = (preferences?.continueWatchingMinutes ?? 0) * 60;
		const existingProgress = progressData.existingProgress;
		const hasActiveProgress =
			existingProgress !== undefined && !existingProgress.completed && (existingProgress.position ?? 0) >= thresholdSeconds;
		const hasActiveTitleProgress =
			hasActiveProgress ||
			(profileId && progressData.mediaFile
				? await this.dependencies.playbackRepository.hasActiveTitleProgress(profileId, progressData.mediaFile.metadataId, thresholdSeconds)
				: false);
		const perTitlePreferences =
			hasActiveTitleProgress && progressData.mediaFile
				? ((await this.dependencies.profileStreamPrefsRepository.findForTitle(profileId, progressData.mediaFile.metadataId)) ?? null)
				: null;

		return {
			file,
			...resolveSessionSelection({
				file,
				preferences,
				perTitlePreferences,
				capabilitiesQuery,
				capabilities,
				smartSelectionEnabled,
				savedAudioStreamIndex: existingProgress?.audioStreamIndex,
				savedSubtitleId: existingProgress?.subtitleId,
				hasActiveProgress,
				hasActiveTitleProgress,
			}),
		};
	}
}

export const sessionLifecycleService = new SessionLifecycleService();
