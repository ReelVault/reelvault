import { serverConfig } from "@/config/server/server.config";
import { systemResourcesService } from "@/config/system-resources.service";
import { workerJobRepository } from "@/repositories/worker.repository";
import type { ClaimNextInput } from "@/repositories/worker-jobs/shared.types";
import { createLogger } from "@/utils/logger.utils";
import { detach } from "@/utils/promise.utils";
import { getWorkerRuntime } from "./worker.runtime";

/** Upper bound for the idle-poll backoff (see scheduleNextPoll). */
const IDLE_BACKOFF_CAP_MS = 15_000;

export class WorkerPollingService {
	readonly serviceName = "WorkerPollingService";
	readonly logger = createLogger("WorkerPollingService");

	private runnerId = "default-runner";
	private pollTimer?: Timer | undefined;
	private pollDebounceTimer?: Timer | undefined;
	private isPolling = false;
	private isRunning = false;
	private lastPollAt = Date.now();
	/** Bumped when a wedged poll is superseded, so its late `finally` cannot reset the new poll's state. */
	private pollGeneration = 0;
	/** The poll currently in flight, so shutdown can wait for it instead of draining a moving target. */
	private inflightPoll: Promise<void> | null = null;
	/** Consecutive polls that found no pending work — drives the idle backoff. */
	private emptyPolls = 0;
	/** Set when work arrives while a poll is already running, so it is not lost to the in-flight guard. */
	private pollAgain = false;

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

	async stop(): Promise<void> {
		this.isRunning = false;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = undefined;
		}

		if (this.pollDebounceTimer) {
			clearTimeout(this.pollDebounceTimer);
			this.pollDebounceTimer = undefined;
		}

		// A poll can be between `findPendingWorkerIds` and `claimNextBatch` when
		// shutdown starts; drain() would snapshot the pool before it starts a job.
		const inflight = this.inflightPoll;
		if (inflight) {
			try {
				await inflight;
			} catch {
				// pollLogged already reports its own failure.
			}
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
			// Re-arm the periodic chain too: a recovery poll started from the
			// debounce used to leave the loop without a next scheduled poll.
			detach(this.pollAndReschedule());
		}, 10);
		this.pollDebounceTimer.unref();
	}

	/**
	 * Watchdog escalation: the polling loop looks wedged. Supersede the in-flight
	 * poll's state with a generation bump, then start a fresh one. The old poll
	 * may still settle later, but its `finally` can no longer clear the new
	 * poll's `isPolling` flag.
	 */
	recoverFromStall(): void {
		if (!this.isRunning) return;

		this.pollGeneration++;
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
		const run = (async () => {
			try {
				await this.poll();
			} catch (error) {
				this.logger.error("Worker polling failed", error);
			}
		})();
		this.inflightPoll = run;

		try {
			await run;
		} finally {
			if (this.inflightPoll === run) this.inflightPoll = null;
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

	/** Claims every eligible worker in one write transaction, then starts the claimed jobs. */
	private async claimAll(input: {
		workerIds: string[];
		runtime: ReturnType<typeof getWorkerRuntime>;
		maxGlobalPool: number;
		activeJobIds: string[];
		now: Date;
	}): Promise<void> {
		const { workerIds, runtime, maxGlobalPool, activeJobIds, now } = input;
		const entries: Array<{ input: ClaimNextInput; definition: NonNullable<ReturnType<typeof runtime.registry.get>>; max: number }> = [];
		let remainingSlots = maxGlobalPool - runtime.pool.totalRunningCount;

		for (const workerId of workerIds) {
			const definition = runtime.registry.get(workerId);
			if (!definition) {
				// Jobs for an unregistered worker (plugin removed/renamed) would
				// otherwise sit pending forever, re-detected on every poll tick.
				this.logger.warn("Pending jobs reference an unregistered worker — skipped", { workerId });

				continue;
			}

			const effectiveConcurrency = definition.concurrency ?? serverConfig.workers.scheduling.defaultConcurrency;
			const freeSlots = Math.min(effectiveConcurrency - runtime.pool.runningCountFor(workerId), remainingSlots);
			if (freeSlots <= 0) continue;

			remainingSlots -= freeSlots;
			entries.push({
				definition,
				max: freeSlots,
				input: {
					workerId,
					runnerId: this.runnerId,
					concurrency: effectiveConcurrency,
					timeoutMs: definition.timeoutMs ?? serverConfig.workers.scheduling.defaultTimeoutMs,
					now,
					// Jobs whose handlers are still hanging in memory must not be
					// recovered and re-claimed by a parallel poll (double execution).
					excludeActiveIds: activeJobIds,
				},
			});
		}
		if (entries.length === 0) return;

		const batches = await workerJobRepository.claimNextBatchMany(entries.map((entry) => ({ input: entry.input, max: entry.max })));

		// The claim is one transaction; a stop during it leaves rows running for
		// the watchdog to recover rather than starting a handler after drain.
		if (!this.isRunningNow()) return;

		for (const [index, claimedItems] of batches.entries()) {
			const definition = entries[index]?.definition;
			if (!definition) continue;

			for (const item of claimedItems) {
				if (!this.isRunningNow()) return;

				runtime.pool.start(definition, item);
			}
		}
	}

	async poll(): Promise<void> {
		if (!this.isRunningNow() || this.isPolling) return;

		const generation = ++this.pollGeneration;
		this.isPolling = true;
		this.lastPollAt = Date.now();

		try {
			const now = new Date();
			const runtime = getWorkerRuntime();
			const maxGlobalPool = systemResourcesService.getWorkerPoolMaxConcurrent();
			if (runtime.pool.totalRunningCount >= maxGlobalPool) {
				// Slot release is event-driven (onSlotFreed), but counting this as an
				// empty poll lets the idle backoff engage instead of waking pointlessly.
				this.emptyPolls++;

				return;
			}

			const pendingWorkerIds = await workerJobRepository.findPendingWorkerIds(now);
			// `stop()` may have run while the query was in flight; starting a job
			// now would land after the drain snapshot.
			if (!this.isRunningNow()) return;
			if (pendingWorkerIds.length === 0) {
				this.emptyPolls++;

				return;
			}

			this.emptyPolls = 0;

			// Snapshot once per poll: rebuilding the set per worker is O(workers x
			// running), and jobs started below are already claimed (status running),
			// so they cannot be recovered again within this tick.
			const activeJobIds = runtime.pool.getActiveJobIds();

			await this.claimAll({ workerIds: pendingWorkerIds, runtime, maxGlobalPool, activeJobIds, now });
		} finally {
			// A superseded poll must not clear the flag of the poll that replaced it.
			if (generation === this.pollGeneration) {
				this.isPolling = false;
				// Drain a wake-up that arrived while this poll was running.
				if (this.pollAgain && this.isRunning) {
					this.pollAgain = false;
					this.triggerPoll();
				}
			}
		}
	}
}
