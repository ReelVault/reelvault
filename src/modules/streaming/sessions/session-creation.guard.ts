import { MINUTE } from "@/config/server/server.constants";
import { CooldownMap } from "@/modules/streaming/utils/cooldown.utils";
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
	private readonly cooldowns: CooldownMap;
	private lastSweepTime = 0;

	constructor(options: GuardOptions = {}) {
		this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.now = options.now ?? Date.now;
		this.cooldowns = new CooldownMap({ cooldownMs: this.cooldownMs, maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES, now: this.now });
	}

	assertCooldown(profileId: string): void {
		const check = this.cooldowns.tryBegin(profileId);
		if (!check.allowed) {
			throw new DomainError(
				"too_many_requests",
				`Playback session creation rate limit exceeded. Please wait ${this.cooldownMs}ms before creating a new session.`,
				{
					code: "stream.creation_throttled",
					params: { retryAfterSeconds: Math.max(1, Math.ceil(check.retryAfterMs / 1000)) },
				},
			);
		}

		const now = this.now();
		if (now - this.lastSweepTime > SWEEP_INTERVAL_MS) {
			this.lastSweepTime = now;
			this.cooldowns.pruneOlderThan(MINUTE);
		}
	}
}
