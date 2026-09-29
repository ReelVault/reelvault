import { canReserveStreamingSession } from "./session-capacity";
import type { SessionStore } from "./session-store";

/**
 * Tracks slots reserved for sessions that are queued/starting but don't have
 * a running FFmpeg process yet, so the capacity check in `reserve()` accounts
 * for in-flight work, not just already-running sessions.
 */
export class SessionReservationTracker {
	private readonly reservedIds = new Set<string>();
	private readonly sessionUsers = new Map<string, string>();
	private readonly store: SessionStore;
	private readonly maxSessionsResolver: number | (() => number);
	private readonly maxSessionsPerUserResolver: number | (() => number | undefined) | undefined;

	constructor(store: SessionStore, maxSessions: number | (() => number), maxSessionsPerUser?: number | (() => number | undefined)) {
		this.store = store;
		this.maxSessionsResolver = maxSessions;
		this.maxSessionsPerUserResolver = maxSessionsPerUser;
	}

	get maxSessions(): number {
		return typeof this.maxSessionsResolver === "function" ? this.maxSessionsResolver() : this.maxSessionsResolver;
	}

	get maxSessionsPerUser(): number | undefined {
		if (this.maxSessionsPerUserResolver === undefined) return undefined;

		return typeof this.maxSessionsPerUserResolver === "function" ? this.maxSessionsPerUserResolver() : this.maxSessionsPerUserResolver;
	}

	reserve(sessionId: string, userId?: string): boolean {
		const alreadyAllocated = this.store.isAttached(sessionId) || this.reservedIds.has(sessionId);

		let activeUserSessions: number | undefined;
		let reservedUserSessions: number | undefined;

		if (userId && this.maxSessionsPerUser !== undefined) {
			activeUserSessions = 0;
			reservedUserSessions = 0;

			for (const [id, uid] of this.sessionUsers.entries()) {
				if (uid === userId) {
					if (this.store.isAttached(id)) activeUserSessions++;
					else if (this.reservedIds.has(id) && id !== sessionId) reservedUserSessions++;
				}
			}
		}

		const canReserve = canReserveStreamingSession({
			activeSessions: this.store.attachedCount(),
			// A session mid seek-restart is both attached and force-reserved — counting
			// its reservation on top of the attached slot double-books it and causes
			// spurious capacity rejections. Only count slots without a process.
			reservedSessions: this.countReservedNotActive(),
			maxSessions: this.maxSessions,
			activeUserSessions,
			reservedUserSessions,
			maxSessionsPerUser: this.maxSessionsPerUser,
			alreadyAllocated,
		});
		if (!canReserve) return false;

		if (!alreadyAllocated) this.reservedIds.add(sessionId);

		if (userId) this.sessionUsers.set(sessionId, userId);

		return true;
	}

	release(sessionId: string): void {
		this.reservedIds.delete(sessionId);
		if (!this.store.has(sessionId)) {
			this.sessionUsers.delete(sessionId);
		}
	}

	/**
	 * Unconditionally reserves the slot vacated by a session whose process was
	 * just stopped (e.g. before a seek restart). No capacity check: the slot
	 * was already accounted for as active a moment ago, so it's guaranteed free.
	 */
	forceReserve(sessionId: string, userId?: string): void {
		this.reservedIds.add(sessionId);
		if (userId) this.sessionUsers.set(sessionId, userId);
	}

	markStarted(sessionId: string): void {
		this.reservedIds.delete(sessionId);
	}

	/**
	 * True when a session has been reserved but has no running process yet —
	 * i.e. a stream-init job is already queued/in-flight for it.
	 */
	isPending(sessionId: string): boolean {
		return this.reservedIds.has(sessionId) && !this.store.isAttached(sessionId);
	}

	get reservedCount(): number {
		return this.reservedIds.size;
	}

	private countReservedNotActive(): number {
		let count = 0;
		for (const id of this.reservedIds) {
			if (!this.store.isAttached(id)) count++;
		}

		return count;
	}

	unbindUser(sessionId: string): void {
		this.sessionUsers.delete(sessionId);
	}

	getUserForSession(sessionId: string): string | undefined {
		return this.sessionUsers.get(sessionId);
	}

	clear(): void {
		this.reservedIds.clear();
		this.sessionUsers.clear();
	}
}
