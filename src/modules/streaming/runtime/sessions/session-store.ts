import type { PlaybackDecision, StreamingSession } from "@sdk/common/stream.types";
import { ConflictError, InternalError, NotFoundError } from "@/utils/errors";
import type { TerminatedSessionEntry } from "../../streaming.types";

/** A creating session without a process past this deadline is a stuck stream-init — the reaper releases it. */
export const RESERVATION_DEADLINE_MS = 60_000;
const MAX_TERMINATED_SESSIONS = 1_000;

export interface SessionRegistration {
	readonly id: string;
	readonly mediaFileId: string;
	readonly profileId: string;
	readonly decision: PlaybackDecision;
	readonly inputPath: string;
	readonly tempDir: string;
	/** Source duration in ms — denominator of the ffmpeg encode percent. */
	readonly durationMs?: number | null | undefined;
}

export interface SessionAccessInfo {
	readonly mediaFileId: string;
	readonly profileId: string;
}

/**
 * Single source of truth for playback session entities. One entry spans the
 * whole viewing of a title — FFmpeg restarts inside it (seek, quality change,
 * software fallback) mutate `process`/`generation` without leaving `active` —
 * plus the terminated-session history used for access checks and the
 * admin-terminate cooldown. Session liveness is driven by client contact
 * (`touch`), never by process liveness.
 */
export class SessionStore {
	private readonly sessions = new Map<string, StreamingSession>();
	private readonly terminatedSessions = new Map<string, TerminatedSessionEntry>();
	private readonly terminatedSessionsByProfileFile = new Map<string, Set<string>>();

	// ─── Entities ───────────────────────────────────────────────────────────

	register(registration: SessionRegistration): StreamingSession {
		if (this.sessions.has(registration.id)) throw new ConflictError(`Session already registered: ${registration.id}`);

		const now = Date.now();
		const session: StreamingSession = {
			id: registration.id,
			mediaFileId: registration.mediaFileId,
			profileId: registration.profileId,
			decision: registration.decision,
			inputPath: registration.inputPath,
			mode: registration.decision.mode,
			tempDir: registration.tempDir,
			operationId: undefined,
			createdAt: now,
			generation: 0,
			process: null,
			startTime: 0,
			lastActivity: now,
			state: "creating",
			durationMs: registration.durationMs ?? null,
			transcodePositionMs: null,
			transcodePercent: null,
			transcodeSpeed: null,
		};
		this.sessions.set(session.id, session);

		return session;
	}

	get(sessionId: string): StreamingSession | undefined {
		return this.sessions.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	get size(): number {
		return this.sessions.size;
	}

	values(): StreamingSession[] {
		return [...this.sessions.values()];
	}

	/** Entries with an attached process handle (dead handles after EOF still count, matching capacity semantics). */
	attachedCount(): number {
		let count = 0;
		for (const session of this.sessions.values()) {
			if (session.process) count++;
		}

		return count;
	}

	isAttached(sessionId: string): boolean {
		return this.sessions.get(sessionId)?.process != null;
	}

	delete(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	clear(): void {
		this.sessions.clear();
		this.terminatedSessions.clear();
		this.terminatedSessionsByProfileFile.clear();
	}

	/**
	 * Attaches a freshly started FFmpeg process. Atomically refuses sessions
	 * whose release was already claimed, so an in-flight seek/start can never
	 * resurrect a session that is being torn down.
	 */
	attachProcess(sessionId: string, process: Bun.Subprocess, startTime: number): void {
		const session = this.sessions.get(sessionId);
		if (!session) throw new NotFoundError(`Session was not registered: ${sessionId}`);

		if (session.state === "ending") throw new InternalError(`Session was released while starting its process: ${sessionId}`);

		session.process = process;
		session.generation += 1;
		session.state = "active";
		session.startTime = startTime;
		// A new process means a new encode (seek/restart) — the previous stats are stale.
		session.transcodePositionMs = null;
		session.transcodePercent = null;
		session.transcodeSpeed = null;
	}

	/** Detaches the exact process handle after a stop; the entity survives restarts. */
	detachProcess(sessionId: string, process: Bun.Subprocess): void {
		const session = this.sessions.get(sessionId);
		if (session?.process === process) session.process = null;
	}

	/** Client contact — refreshes liveness regardless of process state. */
	touch(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session || session.state === "ending") return;

		session.lastActivity = Date.now();
	}

	/**
	 * Claims the right to release: `creating`/`active` → `ending`. Refused for
	 * already-ending sessions. `shouldRelease` is re-evaluated atomically here so
	 * a heartbeat that arrived after the reaper picked the session cancels it.
	 */
	claimRelease(sessionId: string, shouldRelease?: (session: StreamingSession) => boolean): boolean {
		const session = this.sessions.get(sessionId);
		if (!session || session.state === "ending") return false;

		if (shouldRelease && !shouldRelease(session)) return false;

		session.state = "ending";

		return true;
	}

	/** Access is visible for every live state; an `ending` session is already being torn down. */
	getSessionAccess(sessionId: string): SessionAccessInfo | undefined {
		const session = this.sessions.get(sessionId);
		if (!session || session.state === "ending") return undefined;

		return { mediaFileId: session.mediaFileId, profileId: session.profileId };
	}

	setSessionOperation(sessionId: string, operationId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) throw new NotFoundError(`Session is not registered: ${sessionId}`);

		session.operationId = operationId;
	}

	/** Latest ffmpeg stats-line position — written by the transcode progress monitor. */
	setTranscodeProgress(sessionId: string, progress: { positionMs: number; percent: number | null; speed: string | null }): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		session.transcodePositionMs = progress.positionMs;
		session.transcodePercent = progress.percent;
		session.transcodeSpeed = progress.speed;
	}

	/** Updates the negotiated decision (e.g. after a software-encoder fallback). */
	setDecision(sessionId: string, decision: PlaybackDecision): void {
		const session = this.sessions.get(sessionId);
		if (session) session.decision = decision;
	}

	/** Session with an attached process — drives buffer-state and diagnostics. */
	isSessionActive(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);

		return session?.state === "active" && session.process != null;
	}

	/** Creating entries past the reservation deadline — candidates for release by the reaper. */
	findStaleReservations(now: number, deadlineMs: number = RESERVATION_DEADLINE_MS): string[] {
		const staleIds: string[] = [];
		for (const session of this.sessions.values()) {
			if (session.state === "creating" && now - session.createdAt > deadlineMs) staleIds.push(session.id);
		}

		return staleIds;
	}

	// ─── Terminated history ─────────────────────────────────────────────────

	storeTerminated(sessionId: string, access: SessionAccessInfo, reason: string): void {
		if (this.terminatedSessions.size >= MAX_TERMINATED_SESSIONS) {
			const oldestKey = this.terminatedSessions.keys().next().value;
			if (oldestKey) this.deleteTerminated(oldestKey);
		}

		const terminatedAt = Date.now();
		this.terminatedSessions.set(sessionId, {
			mediaFileId: access.mediaFileId,
			profileId: access.profileId,
			reason,
			terminatedAt,
		});
		const key = `${access.profileId}:${access.mediaFileId}`;
		const sessionIds = this.terminatedSessionsByProfileFile.get(key);
		if (sessionIds) sessionIds.add(sessionId);
		else this.terminatedSessionsByProfileFile.set(key, new Set([sessionId]));
	}

	getTerminatedSession(sessionId: string): TerminatedSessionEntry | undefined {
		return this.terminatedSessions.get(sessionId);
	}

	isProfileTerminatedRecently(profileId: string, mediaFileId: string, withinMs: number): { reason: string } | null {
		const cutoff = Date.now() - withinMs;
		for (const sessionId of this.terminatedSessionsByProfileFile.get(`${profileId}:${mediaFileId}`) ?? []) {
			const item = this.terminatedSessions.get(sessionId);
			if (item && item.terminatedAt >= cutoff) return { reason: item.reason };
		}

		return null;
	}

	cleanupTerminatedSessions(maxAge: number): void {
		const cutoff = Date.now() - maxAge;
		for (const [id, item] of this.terminatedSessions.entries()) {
			if (item.terminatedAt < cutoff) {
				this.deleteTerminated(id);
			}
		}
	}

	private deleteTerminated(id: string): void {
		const item = this.terminatedSessions.get(id);
		if (!item) return;

		this.terminatedSessions.delete(id);
		const key = `${item.profileId}:${item.mediaFileId}`;
		const sessionIds = this.terminatedSessionsByProfileFile.get(key);
		if (!sessionIds) return;

		sessionIds.delete(id);
		if (sessionIds.size === 0) this.terminatedSessionsByProfileFile.delete(key);
	}
}
