import type { CreatePlaybackSession, PlaybackDecision, PlaybackSession } from "@reelvault/sdk/common";
import { systemSettingsService } from "@/application/admin/system-settings.service";
import { mediaRepository as defaultMediaRepository } from "@/database/repositories/media-files.repository";
import { playbackRepository } from "@/database/repositories/playback.repository";
import { profilePreferencesRepository as defaultProfilePreferencesRepository } from "@/database/repositories/profile-preferences.repository";
import { profileStreamPrefsRepository } from "@/database/repositories/profile-stream-prefs.repository";
import { assertFFMpegAvailable } from "@/integrations/ffmpeg/ffmpeg.environment";
import { BaseService } from "@/utils/base-service";
import { ConflictError, ForbiddenError, InternalError, ValidationError } from "@/utils/errors";
import { detach } from "@/utils/promise.utils";
import { enqueueStreamInit as defaultEnqueueStreamInit } from "@/workers/definitions/streaming/stream-initialization.worker";
import { workerService as defaultWorkerService } from "@/workers/worker.service";
import { resolveSessionSelection, type SessionSelectionInput } from "../decisions/session-selection.resolver";
import type { SessionAccessInfo } from "../runtime/sessions/session-store";
import { streamingService as streamingRuntimeService } from "../runtime/streaming.manager";
import type { PlaybackSessionInput, SessionReleaseOutcome, TerminatedSessionEntry } from "../streaming.types";
import { PlaybackSessionIdempotencyRegistry } from "./playback-session-idempotency";
import { SessionCreationGuard } from "./session-creation.guard";
import { SessionLifecyclePublisher } from "./session-events.publisher";
import { assertSafeId, parseCapabilities, toPlaybackSessionInput } from "./session-request.mapper";
import { resolveSessionAccess } from "./stream-access";

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
	getTerminatedSession(sessionId: string): TerminatedSessionEntry | undefined;
	reserveSession(sessionId: string, userId?: string): boolean;
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
	profileStreamPrefsRepository: Pick<typeof profileStreamPrefsRepository, "find">;
	playbackRepository: Pick<typeof playbackRepository, "findProgressUpdateData" | "hasActiveTitleProgress">;
	systemSettings: Pick<typeof systemSettingsService, "get">;
	workerService: {
		createOperation(input: { type: string; reference?: { type: string; id: string } }): Promise<{ id: string }>;
		removeOperation(id: string): Promise<void> | void;
	};
	enqueueStreamInit: (
		data: Parameters<typeof defaultEnqueueStreamInit>[0],
		options?: Parameters<typeof defaultEnqueueStreamInit>[1],
	) => Promise<{ operationId?: string | null }>;
	runtime: SessionLifecycleRuntime;
	publisher: Pick<SessionLifecyclePublisher, "publishStarted">;
	assertEnvironment: typeof assertFFMpegAvailable;
}

const defaultDependencies: ServiceDependencies = {
	mediaRepository: defaultMediaRepository,
	profilePreferencesRepository: defaultProfilePreferencesRepository,
	profileStreamPrefsRepository,
	playbackRepository,
	systemSettings: systemSettingsService,
	workerService: defaultWorkerService,
	enqueueStreamInit: defaultEnqueueStreamInit,
	runtime: streamingRuntimeService,
	publisher: new SessionLifecyclePublisher(),
	assertEnvironment: assertFFMpegAvailable,
};

export class SessionLifecycleService extends BaseService {
	private readonly playbackSessionIdempotency = new PlaybackSessionIdempotencyRegistry<PlaybackSession>();
	private readonly creationGuard = new SessionCreationGuard();
	private readonly dependencies: ServiceDependencies;

	constructor(dependencies: ServiceDependencies = defaultDependencies) {
		super("SessionLifecycleService");
		this.dependencies = dependencies;
	}

	async createPlaybackSession(
		body: CreatePlaybackSession,
		profileId: string | undefined,
		idempotencyKey: string,
		userId?: string,
	): Promise<PlaybackSession> {
		if (!profileId) throw new ValidationError("An active profile is required to create a streaming session");

		const recentTermination = this.dependencies.runtime.isProfileTerminatedRecently(profileId, body.mediaFileId, 20_000);
		if (recentTermination?.reason.startsWith("admin.")) {
			throw new ForbiddenError("Playback session was terminated", { code: "stream.session_terminated" });
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

	private async createPlaybackSessionInternal(
		fileId: string,
		capabilitiesQuery: PlaybackSessionInput,
		profileId?: string,
		userId?: string,
	): Promise<PlaybackSession> {
		return await this.safeExecute("createPlaybackSession", async () => {
			const { mediaRepository, profilePreferencesRepository, systemSettings, workerService, enqueueStreamInit, runtime, publisher } =
				this.dependencies;
			this.dependencies.assertEnvironment();
			assertSafeId(fileId);
			if (!profileId) throw new ValidationError("An active profile is required to create a streaming session");

			const [file, preferences, progressData] = await Promise.all([
				mediaRepository.findForPlaybackSession(fileId),
				profilePreferencesRepository.getEffective({ profileId }),
				this.dependencies.playbackRepository.findProgressUpdateData(fileId, profileId),
			]);
			this.assertExists(file, "MediaFile", fileId);

			if (!file.isEnabled) {
				throw new ForbiddenError("This media file is disabled and cannot be played");
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
					? await this.dependencies.playbackRepository.hasActiveTitleProgress(
							profileId,
							progressData.mediaFile.metadataId,
							thresholdSeconds,
						)
					: false);
			const perTitlePreferences =
				hasActiveTitleProgress && progressData.mediaFile
					? await this.dependencies.profileStreamPrefsRepository.find(profileId, progressData.mediaFile.metadataId)
					: null;
			const { decision, videoCodec, audioStream, subtitle, playbackPreferences } = resolveSessionSelection({
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
			});

			this.logger.info(`Playback decision: ${decision.mode}`, {
				fileId,
				reason: decision.reason,
				videoTranscode: decision.videoTranscode,
				audioTranscode: decision.audioTranscode,
			});

			const sessionId = crypto.randomUUID();
			if (!runtime.reserveSession(sessionId, userId)) {
				throw new ConflictError("Concurrent streaming session limit reached. Try again when another stream ends.");
			}

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
				if (!task.operationId) throw new InternalError("Streaming operation was not attached to its task");

				sessionOperationId = task.operationId;
				runtime.setSessionOperation(sessionId, task.operationId);

				publisher.publishStarted({
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
				};
			} catch (error) {
				if (createdOperationId) await workerService.removeOperation(createdOperationId);

				runtime.releaseSessionReservation(sessionId);
				await runtime.discardSession(sessionId);
				throw error;
			}
		});
	}
}

export const sessionLifecycleService = new SessionLifecycleService();
