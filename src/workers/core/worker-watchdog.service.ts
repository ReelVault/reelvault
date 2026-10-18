import { MINUTE } from "@/config/server/server.constants";
import { systemResourcesService } from "@/config/system-resources.service";
import { createLogger } from "@/utils/logger.utils";
import { detach } from "@/utils/promise.utils";
import { workerDependencies } from "@/workers/worker.ports";
import { getWorkerRuntime } from "./worker.runtime";

const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000;
// A 15 s poll gap is normal on a loaded slow box (SQLite checkpoint, GC) —
// scale the stall threshold with measured core speed.
function watchdogTimeoutMs() {
	return systemResourcesService.scaledTimeoutMs(15_000);
}
/** Consecutive stalled checks before the watchdog escalates beyond nudging polling. */
const ESCALATE_AFTER_STALLS = 3;

export class WorkerWatchdogService {
	readonly serviceName = "WorkerWatchdogService";
	readonly logger = createLogger("WorkerWatchdogService");

	private timer: Timer | undefined;
	private recoveryTimer: Timer | undefined;
	private getLastPollAtFn: () => number = () => Date.now();
	private onStallDetectedFn: () => void = () => {
		// intentionally empty
	};
	private onEscalatedFn: () => void = () => {
		// intentionally empty
	};
	private runnerId: string | undefined;

	/** This process's runner id — enables foreign-runner crash recovery (single-instance). */
	setRunnerId(runnerId: string): void {
		this.runnerId = runnerId;
	}

	registerPolling(options: { getLastPollAt: () => number; onStallDetected: () => void; onEscalated?: () => void }): void {
		this.getLastPollAtFn = options.getLastPollAt;
		this.onStallDetectedFn = options.onStallDetected;
		this.onEscalatedFn =
			options.onEscalated ??
			(() => {
				// intentionally empty
			});
	}

	start(): void {
		if (this.timer) return;

		const checkInterval = DEFAULT_WATCHDOG_INTERVAL_MS;

		this.timer = setInterval(() => {
			this.checkHealth();
		}, checkInterval);
		this.timer.unref();

		// Periodically recover orphaned running jobs
		this.recoveryTimer = setInterval(() => {
			detach(
				(async () => {
					try {
						await this.recoverOrphaned();
					} catch {
						// Orphan recovery is fire-and-forget; failures are logged inside.
					}
				})(),
			);
		}, MINUTE);
		this.recoveryTimer.unref();

		this.logger.info("Worker watchdog started", { checkIntervalMs: checkInterval });
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}

		if (this.recoveryTimer) {
			clearInterval(this.recoveryTimer);
			this.recoveryTimer = undefined;
		}

		this.logger.info("Worker watchdog stopped");
	}

	private consecutiveFailures = 0;
	private restarts = 0;
	/** Orphaned running jobs requeued by this process since it started (the rows themselves only keep the attempt count). */
	private recoveredJobs = 0;
	private lastRecoveredAt: Date | undefined;

	private checkHealth(): void {
		const now = Date.now();
		const lastPollAt = this.getLastPollAtFn();
		const elapsed = now - lastPollAt;
		const timeout = watchdogTimeoutMs();

		if (elapsed > timeout) {
			this.consecutiveFailures++;
			this.restarts++;
			this.logger.warn("Worker polling stall detected, restarting polling cycle", {
				consecutiveFailures: this.consecutiveFailures,
				elapsedMs: elapsed,
				thresholdMs: timeout,
			});
			this.onStallDetectedFn();
			// Re-escalate every ESCALATE_AFTER_STALLS consecutive stalls: a genuinely
			// wedged poll loop must keep getting nudged, not just once at exactly 3.
			if (this.consecutiveFailures >= ESCALATE_AFTER_STALLS && this.consecutiveFailures % ESCALATE_AFTER_STALLS === 0) {
				this.logger.error("Worker polling stalled repeatedly — escalating", {
					consecutiveFailures: this.consecutiveFailures,
					elapsedMs: elapsed,
					thresholdMs: timeout,
				});
				this.onEscalatedFn();
			}
		} else {
			this.consecutiveFailures = 0;
		}
	}

	async recoverOrphaned(): Promise<number> {
		try {
			const activeJobIds = getWorkerRuntime().pool.getActiveJobIds();
			const count = await workerDependencies().jobs.recoverOrphanedRunning({
				excludeActiveIds: activeJobIds,
				...(this.runnerId ? { currentRunnerId: this.runnerId } : {}),
			});
			if (count > 0) {
				this.recoveredJobs += count;
				this.lastRecoveredAt = new Date();
				this.logger.warn("Recovered orphaned running worker jobs", { count });
			}

			return count;
		} catch (error) {
			this.logger.error("Failed to recover orphaned running jobs", error);

			return 0;
		}
	}

	getState() {
		const lastPollAt = this.getLastPollAtFn();

		return {
			consecutiveFailures: this.consecutiveFailures,
			elapsedSinceLastPollMs: Date.now() - lastPollAt,
			lastPollAt: new Date(lastPollAt).toISOString(),
			restarts: this.restarts,
			running: Boolean(this.timer),
			recoveredJobs: this.recoveredJobs,
			...(this.lastRecoveredAt ? { lastRecoveredAt: this.lastRecoveredAt.toISOString() } : {}),
		};
	}
}
