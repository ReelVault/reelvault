import type {
	TaskLastExecution,
	TaskTrigger,
	WorkerCategory,
	WorkerCategoryRunResponse,
	WorkerDefinition,
	WorkerQueueStats,
	WorkerSummary,
} from "@reelvault/sdk/common";
import { workerJobRepository } from "@/database/repositories/worker.repository";
import { workerSchedulesRepository } from "@/database/repositories/worker-schedules.repository";
import { MINUTE } from "@/server.constants";
import { DomainError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { detach } from "@/utils/promise.utils";
import { pickDefined } from "@/utils/type.utils";
import { computeNextRunAt } from "../utils/worker-policy.utils";
import { applyStats } from "../utils/worker-stats.mapper";
import { enqueueWithOperation } from "./worker-operation-enqueue";
import { getWorkerRuntime } from "./worker-runtime";

const TIME_OF_DAY_REGEX = /^\d{2}:\d{2}$/;

/** Zeroed queue stats for a worker that has no job rows yet. */
function emptyWorkerStats(def: WorkerDefinition): WorkerQueueStats {
	return {
		workerId: def.id,
		concurrency: def.concurrency ?? 1,
		timeoutMs: def.timeoutMs ?? MINUTE,
		waiting: 0,
		active: 0,
		completed: 0,
		failed: 0,
	};
}

export class WorkerSchedulerService {
	readonly serviceName = "WorkerSchedulerService";
	readonly logger = createLogger("WorkerSchedulerService");

	private readonly customTriggers = new Map<string, TaskTrigger[]>();
	private lastEvaluatedAt?: Date | undefined;
	private hasRunStartupTriggers = false;
	private isEvaluating = false;
	private checkTimer?: Timer | undefined;

	async init(): Promise<void> {
		this.logger.info("Initializing worker scheduler service...");
		try {
			const persisted = await workerSchedulesRepository.getAllTriggers();
			for (const [workerId, triggers] of persisted.entries()) {
				this.customTriggers.set(workerId, triggers);
			}
		} catch (error) {
			this.logger.error("Failed to load persisted worker triggers", error);
		}

		// Overdue deadlines (server was down past a persisted nextRunAt) fire once
		// on this first pass; workers without a deadline yet get one initialized.
		await this.evaluateTriggers();
		if (!this.checkTimer) {
			this.checkTimer = setInterval(() => {
				detach(
					(async () => {
						try {
							await this.evaluateTriggers();
						} catch (err) {
							this.logger.error("Error evaluating scheduled triggers", err);
						}
					})(),
				);
			}, MINUTE);
			this.checkTimer.unref();
		}
	}

	dispose(): void {
		if (this.checkTimer) {
			clearInterval(this.checkTimer);
			this.checkTimer = undefined;
		}
	}

	async evaluateTriggers(now: Date = new Date()): Promise<void> {
		// Serialize passes: a long evaluation that spans a minute boundary must not
		// overlap the next tick (duplicate enqueues / orphaned operations).
		if (this.isEvaluating) return;

		this.isEvaluating = true;
		try {
			await this.evaluateTriggersInternal(now);
		} finally {
			this.isEvaluating = false;
		}
	}

	private async evaluateTriggersInternal(now: Date): Promise<void> {
		const currentMinute = Math.floor(now.getTime() / MINUTE);
		const previousMinute = this.lastEvaluatedAt ? Math.floor(this.lastEvaluatedAt.getTime() / MINUTE) : currentMinute;
		const isStartup = !this.hasRunStartupTriggers;
		if (!isStartup && currentMinute <= previousMinute) return;

		this.hasRunStartupTriggers = true;
		this.lastEvaluatedAt = now;

		const definitions = getWorkerRuntime().registry.getAll();
		// One snapshot per pass. A paused worker (isEnabled = false) fires nothing, startup included.
		const scheduleRows = await workerSchedulesRepository.getAllSchedules();
		const isPaused = (workerId: string) => scheduleRows.get(workerId)?.isEnabled === false;

		if (isStartup) {
			for (const def of definitions) {
				if (isPaused(def.id)) continue;

				const triggers = this.getTriggersForWorker(def.id);
				if (triggers.some((t) => t.type === "startup")) {
					this.logger.info("Triggering worker on startup", { workerId: def.id });
					await this.enqueueScheduled(def.id, `startup:${currentMinute}`, def.schedule?.data);
				}
			}
		}

		// Deadline-based scheduling: every worker carries a persisted nextRunAt.
		// A deadline missed during downtime fires exactly once here (no minute
		// replay, no flood), then advances past `now`. Deadlines are armed and
		// advanced in one batched write after the loop instead of one per worker.
		const deadlineUpdates: Array<{ workerId: string; nextRunAt: Date | null }> = [];
		for (const def of definitions) {
			if (isPaused(def.id)) continue;

			const row = scheduleRows.get(def.id);

			const triggers = this.getTriggersForWorker(def.id);
			const cron = def.schedule?.cron;

			const due = row?.nextRunAt ?? null;
			if (due === null) {
				// First pass for this worker — arm the deadline without firing.
				// Trigger-less workers compute null every tick; writing that null
				// back would bump updatedAt forever for no state change.
				const nextRunAt = computeNextRunAt(triggers, cron, now);
				if (nextRunAt !== null) deadlineUpdates.push({ workerId: def.id, nextRunAt });

				continue;
			}

			if (due.getTime() > now.getTime()) continue;

			this.logger.debug("Triggering scheduled worker", { workerId: def.id, dueAt: due.toISOString() });
			const queued = await this.enqueueScheduled(
				def.id,
				`schedule:${def.id}:${due.getTime()}`,
				def.schedule?.data,
				def.schedule?.operationId,
			);
			// Keep the deadline due when the enqueue failed: advancing it would
			// silently skip the whole period with only a warning in the log.
			if (queued) deadlineUpdates.push({ workerId: def.id, nextRunAt: computeNextRunAt(triggers, cron, now) });
		}

		await workerSchedulesRepository.setNextRunAtMany(deadlineUpdates);
	}

	/** Returns true when the trigger is handled (enqueued or already active) and false on failure. */
	private async enqueueScheduled(workerId: string, dedupeKey: string, data: unknown = {}, operationId?: string): Promise<boolean> {
		try {
			// A dedupe hit inserts nothing; creating the operation first would leave a
			// phantom "pending" operation with zero jobs. Pre-check the active job.
			if (!operationId) {
				const existing = await getWorkerRuntime().queue.findActive(workerId, dedupeKey);
				if (existing) return true;
			}

			await enqueueWithOperation(
				{ type: workerId, reference: { type: "worker", id: workerId } },
				(opId) => getWorkerRuntime().queue.enqueue(workerId, data, { dedupeKey, operationId: opId }),
				{ operationId },
			);

			return true;
		} catch (error) {
			this.logger.warn("Could not enqueue scheduled worker task — the deadline stays due for a retry", { workerId, dedupeKey, error });

			return false;
		}
	}

	getTriggersForWorker(workerId: string): TaskTrigger[] {
		const custom = this.customTriggers.get(workerId);
		// An empty custom list (side effect of a telemetry-only schedules row)
		// falls back to the definition defaults — only a non-empty override governs.
		if (custom && custom.length > 0) return custom;

		const def = getWorkerRuntime().registry.get(workerId);

		return def?.defaultTriggers ?? [];
	}

	async updateWorkerTriggers(workerId: string, triggers: TaskTrigger[]): Promise<TaskTrigger[]> {
		if (!getWorkerRuntime().registry.has(workerId)) {
			throw new DomainError("not_found", `Worker "${workerId}" was not found`, { code: "worker.not_found" });
		}

		for (let i = 0; i < triggers.length; i++) {
			const trigger = triggers[i];
			if (trigger) {
				this.validateTrigger(trigger, workerId, i);
			}
		}

		await workerSchedulesRepository.setTriggers(workerId, triggers);
		this.customTriggers.set(workerId, triggers);
		const def = getWorkerRuntime().registry.get(workerId);
		await workerSchedulesRepository.setNextRunAt(workerId, computeNextRunAt(triggers, def?.schedule?.cron, new Date()));
		this.logger.info("Updated worker triggers", { workerId, triggerCount: triggers.length });

		return triggers;
	}

	/**
	 * Pauses or resumes the scheduled runs of one worker. A paused worker keeps its triggers and fires nothing
	 * automatically. Resuming re-arms the deadline from now, so the paused period is not replayed as a backlog.
	 */
	async setScheduleEnabled(workerId: string, enabled: boolean): Promise<{ workerId: string; enabled: boolean; nextRunAt: string | null }> {
		const def = getWorkerRuntime().registry.get(workerId);
		if (!def) throw new DomainError("not_found", `Worker "${workerId}" was not found`, { code: "worker.not_found" });

		await workerSchedulesRepository.setEnabled(workerId, enabled);
		this.logger.info(enabled ? "Worker schedule resumed" : "Worker schedule paused", { workerId });
		if (!enabled) return { workerId, enabled, nextRunAt: null };

		const nextRunAt = computeNextRunAt(this.getTriggersForWorker(workerId), def.schedule?.cron, new Date());
		await workerSchedulesRepository.setNextRunAt(workerId, nextRunAt);

		return { workerId, enabled, nextRunAt: nextRunAt?.toISOString() ?? null };
	}

	async runWorkerManually(workerId: string, data: unknown = {}): Promise<{ success: true; jobId: string; operationId?: string }> {
		const def = getWorkerRuntime().registry.get(workerId);
		if (!def) throw new DomainError("not_found", `Worker "${workerId}" was not found`, { code: "worker.not_found" });

		const active = await getWorkerRuntime().queue.findActive(workerId, `manual:${workerId}`);
		if (active) {
			throw new DomainError("conflict", `Worker "${workerId}" already has a pending or running manual task`, {
				code: "worker.manual_task_active",
			});
		}

		// A failed enqueue must not leave a dangling operation behind.
		const { operationId, result: job } = await enqueueWithOperation(
			{ type: workerId, reference: { type: "worker", id: workerId } },
			(opId) =>
				getWorkerRuntime().queue.enqueue(workerId, data, {
					dedupeKey: `manual:${workerId}`,
					// Negative = highest priority (claim sorts ascending).
					priority: -10,
					operationId: opId,
				}),
		);

		return { success: true, jobId: job.id, operationId };
	}

	/**
	 * Runs every registered worker of a category one by one. A worker that
	 * already has a pending/running manual task is skipped (per-worker dedupe),
	 * so pressing "run category" twice never duplicates work.
	 */
	async runWorkerCategoryManually(category: WorkerCategory): Promise<WorkerCategoryRunResponse> {
		const members = getWorkerRuntime()
			.registry.getAll()
			.filter((def) => (def.category ?? "application") === category)
			.toSorted((a, b) => a.id.localeCompare(b.id));

		const started: Array<{ workerId: string; jobId: string }> = [];
		const skipped: Array<{ workerId: string; reason: string }> = [];
		for (const def of members) {
			try {
				const result = await this.runWorkerManually(def.id);
				started.push({ workerId: def.id, jobId: result.jobId });
			} catch (error) {
				if (error instanceof DomainError && error.category === "conflict") {
					skipped.push({ workerId: def.id, reason: "already_pending_or_running" });
				} else {
					this.logger.warn("Category run: enqueue failed", { workerId: def.id, category, error });
					skipped.push({ workerId: def.id, reason: "enqueue_failed" });
				}
			}
		}

		this.logger.info("Manual category run", { category, started: started.length, skipped: skipped.length });

		return { success: true, started, skipped };
	}

	async cancelWorker(workerId: string): Promise<{ success: true; cancelledCount: number }> {
		if (!getWorkerRuntime().registry.has(workerId)) {
			throw new DomainError("not_found", `Worker "${workerId}" was not found`, { code: "worker.not_found" });
		}

		const abortedCount = getWorkerRuntime().pool.cancelAllForWorker(workerId);
		const [pendingCount, runningDbCount] = await Promise.all([
			getWorkerRuntime().queue.cancelAllPending(workerId),
			workerJobRepository.cancelAllRunning(workerId),
		]);

		return { success: true, cancelledCount: abortedCount + pendingCount + runningDbCount };
	}

	async listWorkerSummaries(): Promise<WorkerSummary[]> {
		const definitions = getWorkerRuntime().registry.getAll();
		const [statsRows, allSchedules] = await Promise.all([workerJobRepository.getStats(), workerSchedulesRepository.getAllSchedules()]);
		const statsMap = new Map<string, WorkerQueueStats>();

		for (const def of definitions) {
			statsMap.set(def.id, emptyWorkerStats(def));
		}

		for (const row of statsRows) {
			const stats = statsMap.get(row.workerId);
			if (stats) applyStats(stats, row);
		}

		const summaries: WorkerSummary[] = [];
		for (const def of definitions) {
			const triggers = this.getTriggersForWorker(def.id);
			const scheduleRow = allSchedules.get(def.id);

			let lastExecution: TaskLastExecution | undefined;
			if (scheduleRow?.lastRunAt) {
				lastExecution = {
					startedAt: scheduleRow.lastRunAt.toISOString(),
					status: scheduleRow.lastStatus ?? "completed",
					...pickDefined({
						completedAt: scheduleRow.lastCompletedAt?.toISOString(),
						durationMs: scheduleRow.lastDurationMs ?? undefined,
						error: scheduleRow.lastError,
					}),
				};
			}

			summaries.push({
				id: def.id,
				name: def.name ?? def.id,
				category: def.category ?? "application",
				concurrency: def.concurrency ?? 1,
				timeoutMs: def.timeoutMs ?? MINUTE,
				stats: statsMap.get(def.id) ?? emptyWorkerStats(def),
				triggers,
				scheduleEnabled: scheduleRow?.isEnabled ?? true,
				...pickDefined({
					description: def.description,
					lastExecution,
					// A paused schedule shows no next run: its stored deadline never fires.
					nextRunAt: scheduleRow?.isEnabled === false ? undefined : scheduleRow?.nextRunAt?.toISOString(),
				}),
			});
		}

		return summaries;
	}

	private validateTrigger(trigger: TaskTrigger, workerId: string, index: number): void {
		if (trigger.type === "daily" || trigger.type === "weekly") {
			if (!(trigger.timeOfDay && TIME_OF_DAY_REGEX.test(trigger.timeOfDay))) {
				throw new DomainError("validation", `Worker "${workerId}" trigger[${index}] (${trigger.type}) requires valid "timeOfDay" (HH:MM)`, {
					code: "worker.schedule_time_invalid",
				});
			}
		}

		if (trigger.type === "weekly") {
			if (trigger.dayOfWeek === undefined || trigger.dayOfWeek < 0 || trigger.dayOfWeek > 6) {
				throw new DomainError("validation", `Worker "${workerId}" trigger[${index}] (weekly) requires valid "dayOfWeek" (0-6)`, {
					code: "worker.schedule_day_invalid",
				});
			}
		}

		if (trigger.type === "interval") {
			if (!trigger.intervalMinutes || trigger.intervalMinutes < 1) {
				throw new DomainError("validation", `Worker "${workerId}" trigger[${index}] (interval) requires "intervalMinutes" >= 1`, {
					code: "worker.schedule_interval_invalid",
				});
			}
		}
	}
}

export const workerSchedulerService = new WorkerSchedulerService();
