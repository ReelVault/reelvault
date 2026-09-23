import type { PlaybackDecision, PlaybackMode, SessionLifecycleState, StreamingSession, TranscodeConfig } from "@sdk/common/stream.types";
import { getEffectiveHwaccel, getToneMappingMethod } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { serverConfig } from "@/server.config";
import { NotFoundError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { PathUtils } from "@/utils/path.utils";
import { serializeDate } from "@/utils/time.utils";
import { BufferAnalysisCache } from "../buffer/buffer-analysis.cache";
import { PlaylistWaiter } from "../buffer/playlist-waiter";
import { resolveStreamEncoders } from "../diagnostics/encoder-map";
import { ProcessManager } from "../ffmpeg/process-manager";
import { playlistCache } from "../playlist/playlist.cache";
import { SessionSeeker } from "../seeking/session-seeker";
import type { HlsBufferAnalysis, SessionReleaseOutcome, StreamingLifecycleCallbacks, TerminatedSessionEntry } from "../streaming.types";
import { resolveSeekTimelineStart } from "../utils/seek-timeline.utils";
import { parseSegmentName } from "../utils/segment-name.utils";
import { SessionReaper } from "./sessions/session-reaper";
import { SessionReservationTracker } from "./sessions/session-reservation.tracker";
import { SessionStore } from "./sessions/session-store";
import { transcodeProgressMonitor } from "./transcode-progress.monitor";

const noOpLifecycleCallbacks: StreamingLifecycleCallbacks = {
	cancelOperation: async () => {
		// intentionally empty
	},
	onSessionStarted: () => {
		// intentionally empty
	},
	onSessionEnded: () => {
		// intentionally empty
	},
};

/**
 * Runtime facade over the streaming sub-services. Owns no playback state
 * itself — `SessionStore` is the single source of truth. A session is one
 * entity for the whole viewing: seek/quality changes restart the FFmpeg
 * process inside it (`generation` bumps) and never recreate the session.
 */
class StreamingService {
	private readonly logger = createLogger(this.constructor.name);
	private readonly store = new SessionStore();
	private readonly reservations: SessionReservationTracker;
	private readonly bufferCache: BufferAnalysisCache;
	private readonly processManager: ProcessManager;
	private readonly seeker: SessionSeeker;
	private readonly playlistWaiter: PlaylistWaiter;
	private readonly reaper: SessionReaper;
	private readonly softwareFallbackSessions = new Set<string>();
	/** In-flight segment requests per session — a long wait counts as activity. */
	private readonly inflightSegments = new Map<string, number>();

	private readonly config: TranscodeConfig;
	private lifecycleCallbacks = noOpLifecycleCallbacks;

	constructor(config: TranscodeConfig) {
		this.config = config;
		transcodeProgressMonitor.attachStore(this.store);
		this.reservations = new SessionReservationTracker(
			this.store,
			() => this.config.maxSessions,
			() => serverConfig.stream.maxSessionsPerUser,
		);
		this.bufferCache = new BufferAnalysisCache(config.hlsSegmentDuration, (sessionId) => this.getFilePath(sessionId, "playlist.m3u8"));
		this.processManager = new ProcessManager(config, this.store, this.reservations);
		this.seeker = new SessionSeeker(this.store, serverConfig.stream.seekDebounceMs, (sessionId, offset, decision) =>
			this.doSeek(sessionId, offset, decision),
		);
		this.playlistWaiter = new PlaylistWaiter(
			this.store,
			this.reservations,
			(id, file) => this.getFilePath(id, file),
			config.hlsSegmentDuration,
		);
		this.reaper = new SessionReaper(
			this.store,
			this.reservations,
			this.processManager,
			this.bufferCache,
			this.seeker,
			this.playlistWaiter,
			this.softwareFallbackSessions,
		);

		this.reaper.startInactivityTimer(
			{
				inactivityTimeout: () => serverConfig.stream.inactivityTimeoutMs,
				cleanupInterval: config.cleanupInterval,
				isBusy: (id) => this.hasInflightSegment(id),
			},
			(id, reason, shouldRelease) => this.releaseSession(id, reason, shouldRelease),
		);
	}

	configureLifecycleCallbacks(callbacks: StreamingLifecycleCallbacks): void {
		this.lifecycleCallbacks = callbacks;
	}

	async startSession(
		sessionId: string,
		inputPath: string,
		decision: PlaybackDecision,
		startTime = 0,
		operationId?: string,
		timelineStart = startTime,
	): Promise<void> {
		const session = this.store.get(sessionId);
		if (!session) throw new NotFoundError(`Session access was not registered: ${sessionId}`);

		const generationBefore = session.generation;

		try {
			await this.processManager.startSession(sessionId, session, inputPath, decision, startTime, timelineStart, operationId);
			// The process is alive: keep the streaming-session operation open with a
			// live encode percent instead of letting it complete with stream-init.
			await transcodeProgressMonitor.onProcessAttached(sessionId);
			if (generationBefore === 0 && session.generation === 1) {
				this.lifecycleCallbacks.onSessionStarted({ sessionId, mediaFileId: session.mediaFileId, profileId: session.profileId });
			}
		} catch (error) {
			this.reservations.release(sessionId);
			this.logger.error("Failed to start streaming session", error, { sessionId, mode: decision.mode, startTime });
			// Remove the (re)created temp dir on any start failure — an empty dir left
			// behind would linger until the session is released.
			await this.processManager.removeTempDirectory(session.tempDir);
			throw error;
		}
	}

	seekTo(sessionId: string, offset: number, decision: PlaybackDecision): Promise<{ startTime: number; reusedBuffer: boolean }> {
		return this.seeker.seekTo(
			sessionId,
			offset,
			decision,
			this.config.hlsSegmentDuration,
			(id, pos) => this.bufferCache.getBufferedSeekStart(id, pos),
			(id) => this.keepAlive(id),
		);
	}

	isSessionSeeking(sessionId: string): boolean {
		return this.seeker.isSessionSeeking(sessionId);
	}

	getSegmentInfo(segmentName: string): { startTime: number; index: number } {
		return parseSegmentName(segmentName, this.config.hlsSegmentDuration);
	}

	/** Client contact — refreshes liveness regardless of the process state (a finished encode is healthy). */
	keepAlive(sessionId: string): void {
		this.store.touch(sessionId);
	}

	/** Marks a segment request as in-flight so the reaper does not expire it mid-wait. */
	beginSegment(sessionId: string): void {
		const prev = this.inflightSegments.get(sessionId) ?? 0;
		this.inflightSegments.set(sessionId, prev + 1);
	}

	endSegment(sessionId: string): void {
		const count = (this.inflightSegments.get(sessionId) ?? 0) - 1;
		if (count <= 0) this.inflightSegments.delete(sessionId);
		else this.inflightSegments.set(sessionId, count);
	}

	hasInflightSegment(sessionId: string): boolean {
		return (this.inflightSegments.get(sessionId) ?? 0) > 0;
	}

	getSessionState(sessionId: string): { state: SessionLifecycleState; generation: number } | undefined {
		const session = this.store.get(sessionId);
		if (!session) return undefined;

		return { state: session.state, generation: session.generation };
	}

	getFilePath(sessionId: string, fileName: string): string {
		return PathUtils.join(this.config.tempRootDir, sessionId, fileName);
	}

	waitForPlaylist(sessionId: string, timeoutMs = serverConfig.stream.playlistTimeoutMs, signal?: AbortSignal): Promise<void> {
		return this.playlistWaiter.waitForPlaylist(
			sessionId,
			timeoutMs,
			(sid, session) =>
				// Share the seek mutex: a fallback restart and a seek must not both
				// stop + restart the same session concurrently.
				this.seeker.runExclusive(sid, () =>
					this.processManager.retryWithSoftwareEncoder(
						sid,
						session,
						this.softwareFallbackSessions,
						(id) => this.prepareSession(id),
						(id, path, dec, startTime, opId) => this.startSession(id, path, dec, startTime, opId),
					),
				),
			signal,
		);
	}

	/** Stops the running process and clears its output — the session entity itself survives restarts. */
	async prepareSession(sessionId: string): Promise<void> {
		const session = this.store.get(sessionId);
		if (session) {
			await this.processManager.stopRunningProcess(sessionId, session, 300);
			this.reservations.forceReserve(sessionId);
			// The temp dir is wiped+recreated by ProcessManager.startSession.
		}

		this.bufferCache.invalidate(sessionId);
		this.playlistWaiter.invalidate(sessionId);
		playlistCache.invalidate(sessionId);
	}

	hasActiveSession(sessionId: string): boolean {
		return this.store.has(sessionId);
	}

	/** Decision is exposed once the session reached `active` — mirrors "process is up" for clients. */
	getSessionDecision(sessionId: string): PlaybackDecision | undefined {
		const session = this.store.get(sessionId);

		return session?.state === "active" ? session.decision : undefined;
	}

	getSessionStartTime(sessionId: string): number | undefined {
		const session = this.store.get(sessionId);

		return session?.state === "active" ? session.startTime : undefined;
	}

	registerSession(
		sessionId: string,
		access: { mediaFileId: string; profileId: string; decision: PlaybackDecision; inputPath: string; durationMs?: number | null },
	): void {
		this.store.register({
			id: sessionId,
			mediaFileId: access.mediaFileId,
			profileId: access.profileId,
			decision: access.decision,
			inputPath: access.inputPath,
			tempDir: PathUtils.join(this.config.tempRootDir, sessionId),
			durationMs: access.durationMs ?? null,
		});
	}

	getSessionAccess(sessionId: string): { mediaFileId: string; profileId: string } | undefined {
		return this.store.getSessionAccess(sessionId);
	}

	setSessionOperation(sessionId: string, operationId: string): void {
		this.store.setSessionOperation(sessionId, operationId);
	}

	/** Drops a session that never got its first process (failed/aborted stream-init). */
	async discardSession(sessionId: string): Promise<void> {
		const session = this.store.get(sessionId);
		if (session?.state !== "creating" || session.process) return;

		if (this.reservations.isPending(sessionId)) return;

		const tempDir = session.tempDir;
		this.store.delete(sessionId);
		this.reservations.unbindUser(sessionId);
		await this.processManager.removeTempDirectory(tempDir);
	}

	reserveSession(sessionId: string, userId?: string): boolean {
		return this.reservations.reserve(sessionId, userId);
	}

	releaseSessionReservation(sessionId: string): void {
		this.reservations.release(sessionId);
	}

	getActiveSessions(): number {
		return this.store.attachedCount();
	}

	getAllActiveSessions(): StreamingSession[] {
		return this.store.values();
	}

	/** Active sessions owned by one profile — the remote-control page's list. */
	listSessionsForProfile(profileId: string) {
		return this.store.values().reduce<
			Array<{
				sessionId: string;
				mediaFileId: string;
				mode: PlaybackMode;
				state: SessionLifecycleState;
				startedAt: number;
				lastActivity: number;
			}>
		>((acc, session) => {
			if (session.profileId === profileId) {
				acc.push({
					sessionId: session.id,
					mediaFileId: session.mediaFileId,
					mode: session.mode,
					state: session.state,
					startedAt: session.createdAt,
					lastActivity: session.lastActivity,
				});
			}

			return acc;
		}, []);
	}

	async getBuffer(sessionId: string): Promise<HlsBufferAnalysis> {
		return await this.bufferCache.read(sessionId);
	}

	isSessionActive(sessionId: string): boolean {
		return this.store.isSessionActive(sessionId);
	}

	async releaseSession(
		sessionId: string,
		reason: string,
		shouldRelease?: (session: StreamingSession) => boolean,
	): Promise<SessionReleaseOutcome> {
		if (!this.store.claimRelease(sessionId, shouldRelease)) {
			// Either a teardown is in flight (`ending`) or the session already finished
			// (terminated history) — both mean "already ended", never a resurrection.
			const inFlightOrTerminated = this.store.has(sessionId) || this.store.getTerminatedSession(sessionId);

			return inFlightOrTerminated ? "already-ended" : "unknown";
		}

		await this.reaper.finalizeRelease(sessionId, reason, { tempRootDir: this.config.tempRootDir }, this.lifecycleCallbacks);
		playlistCache.invalidate(sessionId);

		return "released";
	}

	getDiagnostics(sessionId: string) {
		const session = this.store.get(sessionId);
		if (!session) return null;

		const effectiveHw = getEffectiveHwaccel();
		const { videoEncoder, audioEncoder } = resolveStreamEncoders(session.decision, effectiveHw);

		return {
			mode: session.mode,
			operationId: session.operationId,
			videoTranscode: session.decision.videoTranscode,
			audioTranscode: session.decision.audioTranscode,
			videoEncoder,
			audioEncoder,
			targetVideoBitrateKbps: session.decision.videoBitrateKbps ?? null,
			hwaccel: effectiveHw.type,
			tonemapped: session.decision.tonemap ?? false,
			toneMapMethod: getToneMappingMethod(),
			reasons: session.decision.reasons ?? { video: { code: "unknown" }, audio: { code: "unknown" } },
			audioStreamIndex: session.decision.audioStreamIndex,
			startTime: session.startTime,
			startedAt: serializeDate(session.createdAt),
			lastActivityAt: serializeDate(session.lastActivity),
			processId: session.process?.pid ?? null,
			processExitCode: session.process?.exitCode ?? null,
			encodePositionSeconds: session.transcodePositionMs !== null ? Number((session.transcodePositionMs / 1000).toFixed(2)) : null,
			encodePercent: session.transcodePercent,
			encodeSpeed: session.transcodeSpeed,
		};
	}

	getTerminatedSession(sessionId: string): TerminatedSessionEntry | undefined {
		return this.store.getTerminatedSession(sessionId);
	}

	isProfileTerminatedRecently(profileId: string, mediaFileId: string, withinMs = 20_000): { reason: string } | null {
		return this.store.isProfileTerminatedRecently(profileId, mediaFileId, withinMs);
	}

	async shutdown(): Promise<void> {
		await this.reaper.shutdown((id, reason) => this.releaseSession(id, reason));
		playlistCache.clear();
	}

	/**
	 * Seek = kill the current process and start a new one at the offset, under
	 * the same session entity. The generation captured at entry is re-checked
	 * after every await: if a release won the race meanwhile, the seek aborts
	 * instead of resurrecting a torn-down session.
	 */
	private async doSeek(sessionId: string, offset: number, decision: PlaybackDecision): Promise<number | undefined> {
		const session = this.store.get(sessionId);
		if (session?.state !== "active") throw new NotFoundError(`Session not found: ${sessionId}`);

		this.logger.debug("Seeking session", { sessionId, offset, mode: decision.mode });
		const generation = session.generation;

		await this.prepareSession(sessionId);

		// Release claimed while the old process was being stopped — do not restart.
		const afterPrepare = this.store.get(sessionId);
		if (afterPrepare?.state !== "active" || afterPrepare.generation !== generation) {
			throw new NotFoundError(`Session released during seek: ${sessionId}`);
		}

		const timelineStart = await resolveSeekTimelineStart(decision.mode, session.inputPath, offset);

		// Same check after the keyframe probe await — the release can win there too.
		const beforeStart = this.store.get(sessionId);
		if (beforeStart?.state !== "active" || beforeStart.generation !== generation) {
			throw new NotFoundError(`Session released during seek: ${sessionId}`);
		}

		await this.startSession(sessionId, session.inputPath, decision, offset, session.operationId, timelineStart);

		return timelineStart;
	}
}

export const streamingService = new StreamingService({
	get maxSessions() {
		return serverConfig.stream.maxSessions;
	},
	get inactivityTimeout() {
		return serverConfig.stream.inactivityTimeoutMs;
	},
	get cleanupInterval() {
		return serverConfig.stream.cleanupIntervalMs;
	},
	get tempRootDir() {
		return serverConfig.paths.transcodes;
	},
	get hlsSegmentDuration() {
		return serverConfig.stream.hlsSegmentDurationSeconds;
	},
});
