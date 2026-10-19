import type { PlaybackDecision, StreamingSession } from "@reelvault/sdk/common";
import type { TerminatedSessionEntry } from "@/modules/streaming/streaming.types";
import { playedSecondsBetween } from "@/modules/streaming/utils/playback-position.utils";
import { DomainError } from "@/utils/domain.errors";
import { isNullish } from "@/utils/type.utils";

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
	/** Video is encoded on the CPU (hardware encoding unavailable or forced off). */
	readonly softwareVideoTranscode?: boolean | undefined;
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
	/** Played media time and furthest position per session, summed from its heartbeat positions (feeds interrupted-session records). */
	private readonly playedTime = new Map<string, { playedSeconds: number; furthestPosition: number; position: number; at: number }>();
	/** Sessions whose video is CPU-encoded, plus slots reserved before registration. */
	private readonly softwareVideoSessions = new WeakSet<StreamingSession>();
	private readonly pendingSoftwareTranscodes = new Set<string>();

	// ─── Entities ───────────────────────────────────────────────────────────

	register(registration: SessionRegistration): StreamingSession {
		if (this.sessions.has(registration.id))
			throw new DomainError("conflict", `Session already registered: ${registration.id}`, { code: "stream.session_exists" });

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
		this.pendingSoftwareTranscodes.delete(session.id);
		if (registration.softwareVideoTranscode === true) this.softwareVideoSessions.add(session);

		return session;
	}

	get(sessionId: string): StreamingSession | undefined {
		return this.sessions.get(sessionId);
	}

	has(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	values(): StreamingSession[] {
		return [...this.sessions.values()];
	}

	/** The media file ids the live sessions play — the delete guards check them. */
	mediaFileIds(): Set<string> {
		const ids = new Set<string>();
		for (const session of this.sessions.values()) ids.add(session.mediaFileId);

		return ids;
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
		return !isNullish(this.sessions.get(sessionId)?.process);
	}

	/**
	 * Adds the media time a heartbeat position shows as played since the session's previous heartbeat. A paused heartbeat adds
	 * none, even when it reports a seek, because the player was not playing; the furthest position still counts.
	 */
	recordPlayedPosition(sessionId: string, position: number, paused: boolean | null, now = Date.now()): void {
		if (!this.sessions.has(sessionId)) return;

		const tracked = this.playedTime.get(sessionId);
		const played = paused === true ? 0 : playedSecondsBetween(tracked, position, now);
		this.playedTime.set(sessionId, {
			playedSeconds: (tracked?.playedSeconds ?? 0) + played,
			furthestPosition: Math.max(tracked?.furthestPosition ?? 0, position),
			position,
			at: now,
		});
	}

	/** Media time the session has played and the furthest position its heartbeats reported (both 0 before the first heartbeat). */
	playbackOf(sessionId: string): { playedSeconds: number; furthestPosition: number } {
		const tracked = this.playedTime.get(sessionId);

		return { playedSeconds: tracked?.playedSeconds ?? 0, furthestPosition: tracked?.furthestPosition ?? 0 };
	}

	delete(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) this.softwareVideoSessions.delete(session);
		this.pendingSoftwareTranscodes.delete(sessionId);
		this.sessions.delete(sessionId);
		this.playedTime.delete(sessionId);
	}

	clear(): void {
		this.sessions.clear();
		this.playedTime.clear();
		this.pendingSoftwareTranscodes.clear();
		this.terminatedSessions.clear();
		this.terminatedSessionsByProfileFile.clear();
	}

	/** Reserves a software-transcode slot before the session exists; false at the cap. */
	tryReserveSoftwareTranscode(sessionId: string, limit: number): boolean {
		if (this.pendingSoftwareTranscodes.has(sessionId)) return true;
		if (this.countSoftwareVideoTranscodes() >= limit) return false;

		this.pendingSoftwareTranscodes.add(sessionId);

		return true;
	}

	releaseSoftwareTranscode(sessionId: string): void {
		this.pendingSoftwareTranscodes.delete(sessionId);
	}

	/** Active plus reserved software video transcodes. */
	countSoftwareVideoTranscodes(): number {
		let count = this.pendingSoftwareTranscodes.size;
		for (const session of this.sessions.values()) {
			if (this.softwareVideoSessions.has(session)) count++;
		}

		return count;
	}

	/** A hardware session that fell back to the CPU encoder still consumes a software slot. */
	markSoftwareVideoSession(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) this.softwareVideoSessions.add(session);
	}

	/**
	 * Attaches a freshly started FFmpeg process. Atomically refuses sessions
	 * whose release was already claimed, so an in-flight seek/start can never
	 * resurrect a session that is being torn down.
	 */
	attachProcess(sessionId: string, process: Bun.Subprocess, startTime: number): void {
		const session = this.sessions.get(sessionId);
		if (!session) throw new DomainError("not_found", `Session was not registered: ${sessionId}`, { code: "stream.session_not_found" });

		if (session.state === "ending")
			throw new DomainError("internal", `Session was released while starting its process: ${sessionId}`, {
				code: "stream.session_released",
			});

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
		if (!session) throw new DomainError("not_found", `Session is not registered: ${sessionId}`, { code: "stream.session_not_found" });

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

		return session?.state === "active" && !isNullish(session.process);
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
