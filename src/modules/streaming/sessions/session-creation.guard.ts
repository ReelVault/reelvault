import { MINUTE } from "@/config/server/server.constants";
import { BoundedMap } from "@/modules/streaming/utils/bounded-map.utils";
import { DomainError } from "@/utils/domain.errors";

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
	private readonly now: () => number;
	private readonly lastCreationByProfile: BoundedMap<number>;
	private lastSweepTime = 0;

	constructor(options: GuardOptions = {}) {
		this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.now = options.now ?? Date.now;
		this.lastCreationByProfile = new BoundedMap({ maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES, now: this.now });
	}

	assertCooldown(profileId: string): void {
		const now = this.now();
		const lastTime = this.lastCreationByProfile.get(profileId);
		if (lastTime !== undefined && now - lastTime < this.cooldownMs) {
			throw new DomainError(
				"too_many_requests",
				`Playback session creation rate limit exceeded. Please wait ${this.cooldownMs}ms before creating a new session.`,
				{
					code: "stream.creation_throttled",
					params: { retryAfterSeconds: Math.max(1, Math.ceil((this.cooldownMs - (now - lastTime)) / 1000)) },
				},
			);
		}

		this.lastCreationByProfile.set(profileId, now);

		if (now - this.lastSweepTime > SWEEP_INTERVAL_MS) {
			this.lastSweepTime = now;
			this.lastCreationByProfile.prune((time, sweepNow) => sweepNow - time > MINUTE);
		}
	}
}
