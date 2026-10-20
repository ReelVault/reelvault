import { realtimeService } from "@/modules/realtime/realtime.service";
import { CooldownMap } from "@/modules/streaming/utils/cooldown.utils";

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
	private readonly cooldowns: CooldownMap;

	constructor(dependencies: Partial<ImplicitSeekDependencies> = {}) {
		this.dependencies = { ...defaultDependencies, ...dependencies };
		this.cooldowns = new CooldownMap({
			cooldownMs: this.dependencies.cooldownMs,
			maxEntries: MAX_TRACKED_SESSIONS,
			now: this.dependencies.now,
		});
	}

	tryBegin(sessionId: string): boolean {
		return this.cooldowns.tryBegin(sessionId).allowed;
	}

	invalidate(sessionId: string): void {
		this.cooldowns.invalidate(sessionId);
	}

	announceSeeked(announcement: SeekedAnnouncement): void {
		this.dependencies.sendToSession(announcement.sessionId, "playback:session:seeked", announcement);
	}
}

/**
 * Shared instance so session teardown can drop a session's cooldown entry —
 * the bounded map only prunes on write pressure, so released sessions would
 * otherwise linger until the map fills.
 */
export const implicitSeekCoordinator = new ImplicitSeekCoordinator();
