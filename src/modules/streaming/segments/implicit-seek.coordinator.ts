import { realtimeService } from "@/modules/realtime";

const IMPLICIT_SEEK_COOLDOWN_MS = 10_000;
/** Bound the per-session cooldown map — entries older than the cooldown are stale. */
const MAX_TRACKED_SESSIONS = 1_000;

export interface ImplicitSeekDependencies {
	sendToSession: (sessionId: string, event: string, payload: unknown) => void;
	now: () => number;
	cooldownMs: number;
}

const defaultDependencies: ImplicitSeekDependencies = {
	sendToSession: (sessionId, event, payload) => realtimeService.sendToSession(sessionId, event, payload),
	now: Date.now,
	cooldownMs: IMPLICIT_SEEK_COOLDOWN_MS,
};

export interface SeekedAnnouncement {
	sessionId: string;
	startTime: number;
	position: number;
}

/**
 * Implicit-seek policy: enforces a per-session cooldown (so one badly matched
 * segment cannot trigger an avalanche of seeks) and broadcasts performed seeks to clients.
 */
export class ImplicitSeekCoordinator {
	private readonly dependencies: ImplicitSeekDependencies;
	private readonly lastSeekAt = new Map<string, number>();

	constructor(dependencies: Partial<ImplicitSeekDependencies> = {}) {
		this.dependencies = { ...defaultDependencies, ...dependencies };
	}

	tryBegin(sessionId: string): boolean {
		const now = this.dependencies.now();
		const lastSeekAt = this.lastSeekAt.get(sessionId);
		if (lastSeekAt !== undefined && now - lastSeekAt < this.dependencies.cooldownMs) {
			return false;
		}

		if (this.lastSeekAt.size >= MAX_TRACKED_SESSIONS) this.pruneStale(now);

		this.lastSeekAt.set(sessionId, now);

		return true;
	}

	private pruneStale(now: number): void {
		for (const [sessionId, lastSeekAt] of this.lastSeekAt) {
			if (now - lastSeekAt >= this.dependencies.cooldownMs) this.lastSeekAt.delete(sessionId);
		}
	}

	invalidate(sessionId: string): void {
		this.lastSeekAt.delete(sessionId);
	}

	announceSeeked(announcement: SeekedAnnouncement): void {
		this.dependencies.sendToSession(announcement.sessionId, "playback:session:seeked", announcement);
	}
}
