import { workerJobRepository } from "@/database/repositories/worker.repository";
import { serverConfig } from "@/server.config";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { detach } from "@/utils/promise.utils";
import { getWorkerRuntime } from "./worker-runtime";

/** Upper bound for the idle-poll backoff (see scheduleNextPoll). */
const IDLE_BACKOFF_CAP_MS = 15_000;

/** Pool doubles may start synchronously; async start failures belong to the pool, not the poll loop. */
function detachStarted(started: void | Promise<void>): void {
	if (!(started instanceof Promise)) return;

	detach(
		(async () => {
			try {
				await started;
			} catch {
				// Pool start owns its failure reporting; a rejected start is not poll-fatal.
			}
		})(),
	);
}

export class WorkerPollingService extends BaseService {
	private runnerId = "default-runner";
	private pollTimer?: Timer | undefined;
	private pollDebounceTimer?: Timer | undefined;
	private isPolling = false;
	private isRunning = false;
	private lastPollAt = Date.now();
	/** Consecutive polls that found no pending work — drives the idle backoff. */
	private emptyPolls = 0;
	/** Set when work arrives while a poll is already running, so it is not lost to the in-flight guard. */
	private pollAgain = false;

	constructor() {
		super("WorkerPollingService");
	}

	setRunnerId(runnerId: string): void {
		this.runnerId = runnerId;
	}

	get lastPollTimestamp(): number {
		return this.lastPollAt;
	}

	start(): void {
		if (this.isRunning) return;

		this.isRunning = true;
		this.scheduleNextPoll();
		this.triggerPoll();
		this.logger.info("Worker polling loop started");
	}

	stop(): void {
		this.isRunning = false;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}

		if (this.pollDebounceTimer) {
			clearTimeout(this.pollDebounceTimer);
			this.pollDebounceTimer = undefined;
		}

		this.logger.info("Worker polling loop stopped");
	}

	triggerPoll(): void {
		if (!this.isRunning) return;

		// An enqueue means fresh work — drop any idle backoff immediately.
		this.emptyPolls = 0;
		// A poll is already in flight. The work that just arrived may be beyond the
		// batch it already claimed, so remember to poll again once it finishes
		// instead of dropping the wake-up (the old debounce silently lost it).
		if (this.isPolling) {
			this.pollAgain = true;

			return;
		}

		if (this.pollDebounceTimer) return;

		this.pollDebounceTimer = setTimeout(() => {
			this.pollDebounceTimer = undefined;
			detach(this.pollLogged());
		}, 10);
		this.pollDebounceTimer.unref();
	}

	/**
	 * Watchdog escalation: the polling loop looks wedged. Clear the in-flight
	 * guard so a fresh poll can run, then trigger it.
	 */
	recoverFromStall(): void {
		if (!this.isRunning) return;

		this.isPolling = false;
		this.pollAgain = false;
		this.triggerPoll();
	}

	private scheduleNextPoll(): void {
		if (!this.isRunning) return;

		if (this.pollTimer) clearTimeout(this.pollTimer);

		// Idle backoff: the base interval doubles per empty poll (cap 15s) so an
		// quiet server stops paying one SELECT per second. Any enqueue resets it
		// via triggerPoll; latency for real work is unchanged.
		const pollIntervalMs = serverConfig.workers.scheduling.pollIntervalMs;
		const backoffMultiplier = Math.min(2 ** Math.min(this.emptyPolls, 4), IDLE_BACKOFF_CAP_MS / pollIntervalMs);
		const delay = Math.max(pollIntervalMs, Math.round(pollIntervalMs * backoffMultiplier));

		this.pollTimer = setTimeout(() => {
			detach(this.pollAndReschedule());
		}, delay);
		this.pollTimer.unref();
	}

	/**
	 * Poll wrapper that can never reject; polls report their own failures.
	 */
	private async pollLogged(): Promise<void> {
		try {
			await this.poll();
		} catch (error) {
			this.logger.error("Worker polling failed", error);
		}
	}

	private async pollAndReschedule(): Promise<void> {
		await this.pollLogged();
		this.scheduleNextPoll();
	}

	/**
	 * Fresh read of the run flag: `poll()` awaits, and TypeScript keeps narrowing
	 * `this.isRunning` to `true` across awaits, so reading the field directly in
	 * the `finally` below would be flagged as always-true (and the runtime value
	 * can genuinely change when `stop()` runs mid-poll).
	 */
	private isRunningNow(): boolean {
		return this.isRunning;
	}

	async poll(): Promise<void> {
		if (!this.isRunningNow() || this.isPolling) return;

		this.isPolling = true;
		this.lastPollAt = Date.now();

		try {
			const now = new Date();
			const runtime = getWorkerRuntime();
			const maxGlobalPool = systemResourcesService.getWorkerPoolMaxConcurrent();
			if (runtime.pool.totalRunningCount >= maxGlobalPool) return;

			const pendingWorkerIds = await workerJobRepository.findPendingWorkerIds(now);
			if (pendingWorkerIds.length === 0) {
				this.emptyPolls++;

				return;
			}

			this.emptyPolls = 0;

			for (const workerId of pendingWorkerIds) {
				if (runtime.pool.totalRunningCount >= maxGlobalPool) break;

				const definition = runtime.registry.get(workerId);
				if (!definition) {
					// Jobs for an unregistered worker (plugin removed/renamed) would
					// otherwise sit pending forever, re-detected on every poll tick.
					this.logger.warn("Pending jobs reference an unregistered worker — skipped", { workerId });
					continue;
				}

				const effectiveConcurrency = definition.concurrency ?? serverConfig.workers.scheduling.defaultConcurrency;
				const freeSlots = Math.min(
					effectiveConcurrency - runtime.pool.runningCountFor(workerId),
					maxGlobalPool - runtime.pool.totalRunningCount,
				);
				if (freeSlots <= 0) continue;

				// One transaction claims every runnable job for this worker — the
				// sequential claimNext re-ran recover/candidates/counts per job.
				const claimedItems = await workerJobRepository.claimNextBatch(
					{
						workerId,
						runnerId: this.runnerId,
						concurrency: effectiveConcurrency,
						timeoutMs: definition.timeoutMs ?? serverConfig.workers.scheduling.defaultTimeoutMs,
						now,
						// Jobs whose handlers are still hanging in memory must not be
						// recovered and re-claimed by a parallel poll (double execution).
						excludeActiveIds: runtime.pool.getActiveJobIds(),
					},
					freeSlots,
				);

				for (const item of claimedItems) {
					detachStarted(runtime.pool.start(definition, item));
				}
			}
		} finally {
			this.isPolling = false;
			// Drain a wake-up that arrived while this poll was running.
			if (this.pollAgain && this.isRunning) {
				this.pollAgain = false;
				this.triggerPoll();
			}
		}
	}
}
