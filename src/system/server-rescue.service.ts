import { ffmpegProcessTracker } from "@/integrations/ffmpeg/ffmpeg.process-tracker";
import { realtimeService } from "@/modules/realtime";
import { serverConfig } from "@/server.config";
import { BaseService } from "@/utils/base-service";
import { clamp } from "@/utils/math.utils";
import { detach } from "@/utils/promise.utils";

export type RescueState = "healthy" | "rescuing";

export type SystemPressure = "low" | "medium" | "high" | "critical";

export interface RescueActions {
	/** Abort running background worker tasks (non-streaming workers). */
	cancelBackgroundTasks: () => void;
}

export interface RescueSnapshot {
	state: RescueState;
	stateSince: number;
	reason?: string | undefined;
	lastLagMs: number;
	lastPressure: SystemPressure;
	escalations: number;
}

/**
 * How often the rescue state machine evaluates collected signals. Lag sampling
 * runs more often (see LAG_SAMPLE_INTERVAL_MS) and the worst drift between two
 * checks is what gets evaluated.
 */
const CHECK_INTERVAL_MS = 5_000;
const LAG_SAMPLE_INTERVAL_MS = 1_000;
/** Minimum gap between two escalations while already rescuing. */
const ESCALATION_COOLDOWN_MS = 30_000;

/**
 * Flap escalation: every re-entry aborts running background tasks, whose retries
 * then re-create the exact load that breached the threshold — the cure becomes
 * the disease (observed: 200+ engage/release cycles in 13 h on a slow box).
 * Each re-entry inside FLAP_WINDOW_MS raises the effective lag threshold so the
 * machine gets progressively longer work windows; `critical` pressure bypasses
 * the lag threshold entirely, so memory/disk emergencies still engage instantly.
 */
const FLAP_WINDOW_MS = 15 * 60_000;
const FLAP_COUNT = 3;
const FLAP_THRESHOLD_STEP = 1.5;
const FLAP_THRESHOLD_CAP = 4;
/** Engage timestamps older than this are forgotten, resetting a calm server to the configured thresholds. */
const FLAP_MEMORY_MS = 60 * 60_000;

/**
 * Workers that must survive rescue mode: they serve active playback sessions.
 * Everything else (scans, ingest, analysis, trickplay plugins, metadata, images,
 * loudness) is expendable — that work can resume once the server is healthy.
 */
const PROTECTED_WORKER_IDS = new Set(["stream-init", "streamInit", "transcode"]);

/**
 * Server Rescue — last-resort protection when the server starts freezing.
 *
 * Signals:
 * - Event-loop lag: a 1 s drift sampler measures how late timers fire. Sustained
 *   lag above the configured threshold means the JS thread cannot keep up
 *   (synchronous SQLite, floods of callbacks) — exactly the "nothing responds"
 *   state.
 * - System pressure: the resource allocator's pressure level (CPU/memory/disk).
 *   "critical" counts as a breach on its own.
 *
 * Response (staged, reversible):
 * 1. While rescuing, `getRescueAllocation` forces concurrency 0 for every
 *    non-protected worker — the poller stops claiming new background tasks.
 * 2. If the breach persists, escalation aborts already-running background tasks
 *    and kills background FFmpeg processes (plugin trickplay, scans) — playback
 *    FFmpeg processes are tagged "streaming" and are never touched.
 * 3. After the machine stays healthy for `releaseMs`, background work resumes.
 *
 * Watcher-triggered library scans consult `isThrottling()` and wait instead of
 * piling more work onto a drowning server.
 */
class ServerRescueService extends BaseService {
	private state: RescueState = "healthy";
	private stateSince = Date.now();
	private breachSince: number | null = null;
	private healthySince: number | null = null;
	private lastEscalationAt = 0;
	private escalations = 0;
	private lastLagMs = 0;
	private lastPressure: SystemPressure = "low";
	private lastReason?: string | undefined;
	private maxLagSinceCheck = 0;

	private lagSamplerTimer?: Timer | undefined;
	private checkTimer?: Timer | undefined;
	private pressureProvider: () => SystemPressure = () => "low";
	private speedFactorProvider: () => number = () => 1;
	private engageTimes: number[] = [];
	private actions?: RescueActions | undefined;
	private isInitialized = false;

	constructor() {
		super("ServerRescueService");
	}

	registerPressureProvider(provider: () => SystemPressure): void {
		this.pressureProvider = provider;
	}

	registerSpeedFactorProvider(provider: () => number): void {
		this.speedFactorProvider = provider;
	}

	registerActions(actions: RescueActions): void {
		this.actions = actions;
	}

	init(): void {
		if (this.isInitialized) return;

		this.isInitialized = true;

		if (!serverConfig.rescue.enabled) {
			this.logger.info("Server rescue monitor disabled in system settings");

			return;
		}

		this.armLagSampler();
		this.checkTimer = setInterval(() => this.runCheck(), CHECK_INTERVAL_MS);
		this.checkTimer.unref();
		this.logger.info("Server rescue monitor armed", {
			checkIntervalMs: CHECK_INTERVAL_MS,
			lagThresholdMs: serverConfig.rescue.eventLoopLagMs,
			effectiveLagThresholdMs: Math.round(this.effectiveLagThresholdMs(Date.now())),
			sustainMs: serverConfig.rescue.sustainMs,
		});
	}

	shutdown(): void {
		if (this.lagSamplerTimer) {
			clearTimeout(this.lagSamplerTimer);
			this.lagSamplerTimer = undefined;
		}

		if (this.checkTimer) {
			clearInterval(this.checkTimer);
			this.checkTimer = undefined;
		}

		this.isInitialized = false;
		this.state = "healthy";
		this.breachSince = null;
		this.healthySince = null;
		this.engageTimes = [];
	}

	isThrottling(): boolean {
		return this.state === "rescuing";
	}

	isWorkerProtected(workerId: string): boolean {
		return PROTECTED_WORKER_IDS.has(workerId);
	}

	/**
	 * Allocation override consumed by the resource allocator. Returns 0 concurrency
	 * for every non-protected worker while rescuing — even when the admin configured
	 * an explicit concurrency, rescue outranks user settings.
	 */
	getRescueAllocation(workerId: string): { allocated: 0; throttled: true; reason: "server_rescue" } | undefined {
		if (this.state !== "rescuing") return undefined;

		if (PROTECTED_WORKER_IDS.has(workerId)) return undefined;

		return { allocated: 0, throttled: true, reason: "server_rescue" };
	}

	getState(): RescueSnapshot {
		return {
			state: this.state,
			stateSince: this.stateSince,
			reason: this.lastReason,
			lastLagMs: this.lastLagMs,
			lastPressure: this.lastPressure,
			escalations: this.escalations,
		};
	}

	/** Measures timer drift: how much later than LAG_SAMPLE_INTERVAL_MS the callback fired. */
	private armLagSampler(): void {
		if (!this.isInitialized) return;

		const armedAt = Date.now();
		this.lagSamplerTimer = setTimeout(() => {
			if (!this.isInitialized) return;

			const drift = Math.max(0, Date.now() - armedAt - LAG_SAMPLE_INTERVAL_MS);
			if (drift > this.maxLagSinceCheck) this.maxLagSinceCheck = drift;

			this.armLagSampler();
		}, LAG_SAMPLE_INTERVAL_MS);
		this.lagSamplerTimer.unref();
	}

	/** `now` is injectable so tests can drive the state machine without fake timers. */
	private runCheck(now: number = Date.now()): void {
		const lagMs = this.maxLagSinceCheck;
		this.maxLagSinceCheck = 0;

		if (!serverConfig.rescue.enabled) {
			if (this.state === "rescuing") this.exitRescue(now, "rescue disabled in system settings");

			return;
		}

		this.evaluate(lagMs, this.pressureProvider(), now);
	}

	/** Slow single cores legitimately block the event loop longer (synchronous
	 * SQLite bursts), so lag/sustain budgets get the same headroom formula as
	 * `scaledTimeoutMs`: fast boxes keep the base, slow boxes get up to 2×. */
	private slowCoreScale(): number {
		return clamp(2 - this.speedFactorProvider(), 1, 2);
	}

	/** ×`FLAP_THRESHOLD_STEP` per re-entry inside the flap window, capped; engage
	 * timestamps age out after `FLAP_MEMORY_MS`, so a calm server resets to the
	 * configured thresholds. */
	private flapMultiplier(now: number): number {
		this.engageTimes = this.engageTimes.filter((engagedAt) => now - engagedAt < FLAP_MEMORY_MS);
		const recentEngages = this.engageTimes.filter((engagedAt) => now - engagedAt <= FLAP_WINDOW_MS).length;
		if (recentEngages < FLAP_COUNT) return 1;

		return Math.min(FLAP_THRESHOLD_CAP, FLAP_THRESHOLD_STEP ** (recentEngages - FLAP_COUNT + 1));
	}

	private effectiveLagThresholdMs(now: number): number {
		return serverConfig.rescue.eventLoopLagMs * this.slowCoreScale() * this.flapMultiplier(now);
	}

	private effectiveSustainMs(): number {
		return serverConfig.rescue.sustainMs * this.slowCoreScale();
	}

	private evaluate(lagMs: number, pressure: SystemPressure, now: number): void {
		this.lastLagMs = lagMs;
		this.lastPressure = pressure;

		const lagThresholdMs = this.effectiveLagThresholdMs(now);
		const lagBreached = lagMs >= lagThresholdMs;
		const pressureBreached = pressure === "critical";
		const breach = lagBreached || pressureBreached;
		// `high` CPU/mem/disk without event-loop lag must be releasable — a software
		// transcode legitimately pins a slow box, and treating it like `critical` kept
		// every background worker paused forever.
		const settled = !lagBreached && pressure !== "critical";

		if (this.state === "healthy") {
			if (!breach) {
				this.breachSince = null;

				return;
			}

			this.breachSince ??= now;
			if (now - this.breachSince >= this.effectiveSustainMs()) {
				this.enterRescue(this.describeBreach(lagMs, pressure, lagThresholdMs), now);
			}

			return;
		}

		if (settled) {
			this.healthySince ??= now;
			if (now - this.healthySince >= serverConfig.rescue.releaseMs) {
				this.exitRescue(now, "system healthy again");
			}

			return;
		}

		this.healthySince = null;
		if (breach && now - this.lastEscalationAt >= ESCALATION_COOLDOWN_MS) {
			this.escalate(this.describeBreach(lagMs, pressure, lagThresholdMs), now);
		}
	}

	private describeBreach(lagMs: number, pressure: SystemPressure, lagThresholdMs: number): string {
		if (pressure === "critical") return `system pressure critical (lag ${lagMs}ms)`;

		return `event loop lag ${lagMs}ms >= ${Math.round(lagThresholdMs)}ms threshold`;
	}

	private enterRescue(reason: string, now: number): void {
		this.state = "rescuing";
		this.stateSince = now;
		this.breachSince = null;
		this.healthySince = null;
		this.lastReason = reason;
		this.engageTimes.push(now);
		this.logger.warn(`SERVER RESCUE engaged: ${reason} — pausing all background work, playback stays live`, { reason });

		// Escalate immediately on entry: the sustained breach proves background work
		// is what's drowning us, so stop it at the source (running tasks + FFmpeg).
		this.escalate(reason, now);
		this.broadcast();
	}

	private exitRescue(now: number, reason: string): void {
		const rescuedForMs = now - this.stateSince;
		this.state = "healthy";
		this.stateSince = now;
		this.breachSince = null;
		this.healthySince = null;
		this.lastReason = reason;
		this.logger.info(`Server rescue released after ${rescuedForMs}ms: ${reason} — background work resumed`, { reason });
		this.broadcast();
	}

	private escalate(reason: string, now: number): void {
		this.lastEscalationAt = now;
		this.escalations++;
		this.logger.warn(`Server rescue escalation #${this.escalations}: ${reason} — aborting background tasks and background FFmpeg`, {
			reason,
			escalations: this.escalations,
		});

		try {
			this.actions?.cancelBackgroundTasks();
		} catch (error) {
			this.logger.error("Server rescue: failed to cancel background tasks", error);
		}

		try {
			ffmpegProcessTracker.killAllBackground();
		} catch (error) {
			this.logger.error("Server rescue: failed to kill background FFmpeg processes", error);
		}
	}

	private broadcast(): void {
		// Rescue state is admin-panel material — role-scoped fan-out instead of a
		// global broadcast that would hand server internals to every user.
		detach(
			(async () => {
				try {
					await realtimeService.sendToAdmins("system.rescue_state", this.getState());
				} catch (error) {
					this.logger.error("Failed to broadcast rescue state", error);
				}
			})(),
		);
	}
}

export const serverRescueService = new ServerRescueService();

export { ServerRescueService };
