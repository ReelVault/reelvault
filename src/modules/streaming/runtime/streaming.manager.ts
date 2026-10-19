import type { PlaybackDecision, SessionLifecycleState, StreamingSession, TranscodeConfig } from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";
import { getEffectiveHwaccel, getToneMappingMethod } from "@/integrations/ffmpeg/ffmpeg.capabilities";
import { getBufferedSeekStart } from "@/modules/streaming/buffer/hls-buffer.utils";
import { PlaylistWaiter } from "@/modules/streaming/buffer/playlist.waiter";
import { ProcessManager } from "@/modules/streaming/ffmpeg/process.manager";
import { usesSoftwareVideoEncode } from "@/modules/streaming/ffmpeg/software-fallback.policy";
import { playlistFileCache } from "@/modules/streaming/playlist/playlist.cache";
import { SessionSeeker } from "@/modules/streaming/seeking/session.seeker";
import { implicitSeekCoordinator } from "@/modules/streaming/segments/implicit-seek.coordinator";
import type {
	HlsBufferAnalysis,
	SessionReleaseOutcome,
	StreamingLifecycleCallbacks,
	TerminatedSessionEntry,
} from "@/modules/streaming/streaming.types";
import { resolveSeekTimelineStart } from "@/modules/streaming/utils/seek-timeline.utils";
import { PLAYLIST_FILE_NAME, parseSegmentName } from "@/modules/streaming/utils/segment-name.utils";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { PathUtils } from "@/utils/path.utils";
import { SessionReaper } from "./session-state/session.reaper";
import { SessionStore } from "./session-state/session.store";
import { SessionReservationTracker } from "./session-state/session-reservation.tracker";
import { buildSessionDiagnostics, type StreamEnvironment, toProfileSessionView } from "./session-views.mapper";
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

interface ManagerStartInput {
	sessionId: string;
	inputPath: string;
	decision: PlaybackDecision;
	startTime?: number | undefined;
	operationId?: string | undefined;
	timelineStart?: number | undefined;
}

/**
 * Runtime facade over the streaming sub-services. Owns no playback state
 * itself — `SessionStore` is the single source of truth. A session is one
 * entity for the whole viewing: seek/quality changes restart the FFmpeg
 * process inside it (`generation` bumps) and never recreate the session.
 */
class StreamingManager {
	readonly logger = createLogger(this.constructor.name);
	private readonly store = new SessionStore();
	private readonly reservations: SessionReservationTracker;
	private readonly processManager: ProcessManager;
	private readonly seeker: SessionSeeker;
	private readonly playlistWaiter: PlaylistWaiter;
	private readonly reaper: SessionReaper;
	private readonly softwareFallbackSessions = new Set<string>();
	/** In-flight segment requests per session — a long wait counts as activity. */
	private readonly inflightSegments = new Map<string, number>();
	/** Encoder environment captured at registration; WeakMap so released sessions are collected. */
	private readonly streamEnvironments = new WeakMap<StreamingSession, StreamEnvironment>();

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
		this.reaper = new SessionReaper({
			store: this.store,
			reservations: this.reservations,
			processManager: this.processManager,
			playlistFiles: playlistFileCache,
			seeker: this.seeker,
			playlistWaiter: this.playlistWaiter,
			softwareFallbackSessions: this.softwareFallbackSessions,
			implicitSeek: implicitSeekCoordinator,
		});

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

	async startSession({
		sessionId,
		inputPath,
		decision,
		startTime = 0,
		operationId,
		timelineStart = startTime,
	}: ManagerStartInput): Promise<void> {
		const session = this.store.get(sessionId);
		if (!session)
			throw new DomainError("not_found", `Session access was not registered: ${sessionId}`, { code: "stream.session_not_found" });

		const generationBefore = session.generation;

		try {
			await this.processManager.startSession({ sessionId, session, inputPath, decision, startTime, timelineStart, operationId });
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
		return this.seeker.seekTo(sessionId, offset, decision, this.config.hlsSegmentDuration, {
			getBufferedSeekStart: (id, pos) => this.bufferedSeekStart(id, pos),
			keepAlive: (id) => this.keepAlive(id),
		});
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

	/** Keeps the position and pause state a heartbeat reported, so the profile's session list shows where each stream is. */
	recordHeartbeatPosition(sessionId: string, positionSeconds: number, paused: boolean | null): void {
		const session = this.store.get(sessionId);
		if (!session) return;

		session.lastPositionSeconds = positionSeconds;
		session.lastPaused = paused;
		this.store.recordPlayedPosition(sessionId, positionSeconds, paused);
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
						(id, path, dec, startTime, opId) =>
							this.startSession({ sessionId: id, inputPath: path, decision: dec, startTime, operationId: opId }),
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
			// The release path is not serialized by the seeker lock: if it completed
			// during the await, re-reserving would leak a reservation nothing releases.
			if (this.store.get(sessionId)) this.reservations.forceReserve(sessionId);
			// The temp dir is wiped+recreated by ProcessManager.startSession.
		}

		playlistFileCache.invalidate(sessionId);
		this.playlistWaiter.invalidate(sessionId);
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
		const session = this.store.register({
			id: sessionId,
			mediaFileId: access.mediaFileId,
			profileId: access.profileId,
			decision: access.decision,
			inputPath: access.inputPath,
			tempDir: PathUtils.join(this.config.tempRootDir, sessionId),
			softwareVideoTranscode: usesSoftwareVideoEncode(access.decision, getEffectiveHwaccel().type),
			durationMs: access.durationMs ?? null,
		});
		this.streamEnvironments.set(session, { hwaccel: getEffectiveHwaccel(), toneMapMethod: getToneMappingMethod() });
	}

	/** Reserve a software-transcode slot before the session exists; false at the capacity cap. */
	tryReserveSoftwareTranscode(sessionId: string, limit: number): boolean {
		return this.store.tryReserveSoftwareTranscode(sessionId, limit);
	}

	releaseSoftwareTranscode(sessionId: string): void {
		this.store.releaseSoftwareTranscode(sessionId);
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

	explainCapacityLimit(userId?: string): { scope: "user" | "server"; limit: number; active: number } {
		return this.reservations.explainCapacityLimit(userId);
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

	/**
	 * The media file ids the live sessions play. The delete guards ask this per
	 * file, and copying the whole session list for every one of them turned a
	 * bulk delete into a quadratic scan.
	 */
	getActiveMediaFileIds(): Set<string> {
		return this.store.mediaFileIds();
	}

	/** Active sessions owned by one profile — the remote-control page's list. */
	listSessionsForProfile(profileId: string) {
		return this.store
			.values()
			.filter((session) => session.profileId === profileId)
			.map((session) => toProfileSessionView(session));
	}

	async getBuffer(sessionId: string): Promise<HlsBufferAnalysis> {
		return await this.readBufferAnalysis(sessionId);
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

		return "released";
	}

	getDiagnostics(sessionId: string) {
		const session = this.store.get(sessionId);
		if (!session) return null;

		return buildSessionDiagnostics(session, this.streamEnvironments.get(session));
	}

	getTerminatedSession(sessionId: string): TerminatedSessionEntry | undefined {
		return this.store.getTerminatedSession(sessionId);
	}

	isProfileTerminatedRecently(profileId: string, mediaFileId: string, withinMs = 20_000): { reason: string } | null {
		return this.store.isProfileTerminatedRecently(profileId, mediaFileId, withinMs);
	}

	async shutdown(): Promise<void> {
		await this.reaper.shutdown((id, reason) => this.releaseSession(id, reason));
	}

	/** Parsed buffer analysis for a session — the seek and diagnostics view over the playlist. */
	private async readBufferAnalysis(sessionId: string): Promise<HlsBufferAnalysis> {
		const result = await playlistFileCache.read(sessionId, this.getFilePath(sessionId, PLAYLIST_FILE_NAME), this.config.hlsSegmentDuration);

		return result.analysis;
	}

	/** Buffered start for a seek position, or null when the position is not buffered. */
	private async bufferedSeekStart(sessionId: string, position: number): Promise<number | null> {
		const analysis = await this.readBufferAnalysis(sessionId);

		return getBufferedSeekStart(analysis, position, this.config.hlsSegmentDuration);
	}

	/**
	 * Seek = kill the current process and start a new one at the offset, under
	 * the same session entity. The generation captured at entry is re-checked
	 * after every await: if a release won the race meanwhile, the seek aborts
	 * instead of resurrecting a torn-down session.
	 */
	private async doSeek(sessionId: string, offset: number, decision: PlaybackDecision): Promise<number | undefined> {
		const session = this.store.get(sessionId);
		if (session?.state !== "active")
			throw new DomainError("not_found", `Session not found: ${sessionId}`, { code: "stream.session_not_found" });

		this.logger.debug("Seeking session", { sessionId, offset, mode: decision.mode });
		const generation = session.generation;

		await this.prepareSession(sessionId);
		// Release claimed while the old process was being stopped — do not restart.
		this.assertSeekStillValid(sessionId, generation);

		const timelineStart = await resolveSeekTimelineStart(decision.mode, session.inputPath, offset);
		// Same check after the keyframe probe await — the release can win there too.
		this.assertSeekStillValid(sessionId, generation);

		await this.startSession({
			sessionId,
			inputPath: session.inputPath,
			decision,
			startTime: offset,
			operationId: session.operationId,
			timelineStart,
		});

		return timelineStart;
	}

	/** Throws when the session was released or restarted since `generation` was captured. */
	private assertSeekStillValid(sessionId: string, generation: number): void {
		const current = this.store.get(sessionId);
		if (current?.state !== "active" || current.generation !== generation) {
			throw new DomainError("not_found", `Session released during seek: ${sessionId}`, { code: "stream.session_released" });
		}
	}
}

export const streamingManager = new StreamingManager({
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
