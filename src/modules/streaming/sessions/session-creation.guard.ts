import { MINUTE } from "@/server.constants";
import { TooManyRequestsError } from "@/utils/errors";

const DEFAULT_COOLDOWN_MS = 500;
const SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 1_000;

interface GuardOptions {
	cooldownMs?: number | undefined;
	maxEntries?: number | undefined;
	now?: (() => number) | undefined;
}

export class SessionCreationGuard {
	private readonly cooldownMs: number;
	private readonly maxEntries: number;
	private readonly now: () => number;
	private readonly lastCreationByProfile = new Map<string, number>();
	private lastSweepTime = 0;

	constructor(options: GuardOptions = {}) {
		this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.now = options.now ?? Date.now;
	}

	assertCooldown(profileId: string): void {
		const now = this.now();
		const lastTime = this.lastCreationByProfile.get(profileId);
		if (lastTime !== undefined && now - lastTime < this.cooldownMs) {
			throw new TooManyRequestsError(
				`Playback session creation rate limit exceeded. Please wait ${this.cooldownMs}ms before creating a new session.`,
			);
		}

		this.lastCreationByProfile.delete(profileId);
		if (this.lastCreationByProfile.size >= this.maxEntries) {
			const oldestKey = this.lastCreationByProfile.keys().next().value;
			if (oldestKey !== undefined) this.lastCreationByProfile.delete(oldestKey);
		}

		this.lastCreationByProfile.set(profileId, now);

		if (now - this.lastSweepTime > SWEEP_INTERVAL_MS) {
			this.lastSweepTime = now;
			for (const [id, time] of this.lastCreationByProfile) {
				if (now - time > MINUTE) this.lastCreationByProfile.delete(id);
			}
		}
	}
}
