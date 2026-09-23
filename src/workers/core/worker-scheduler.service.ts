import type {
	TaskLastExecution,
	TaskTrigger,
	WorkerCategory,
	WorkerCategoryRunResponse,
	WorkerQueueStats,
	WorkerSummary,
} from "@reelvault/sdk/common";
import { workerJobRepository } from "@/database/repositories/worker.repository";
import { workerSchedulesRepository } from "@/database/repositories/worker-schedules.repository";
import { MINUTE } from "@/server.constants";
import { BaseService } from "@/utils/base-service";
import { ConflictError, NotFoundError, ValidationError } from "@/utils/errors";
import { detach } from "@/utils/promise.utils";
import { pickDefined } from "@/utils/type.utils";
import { computeNextRunAt } from "../utils/worker-policy.utils";
import { applyStats } from "../utils/worker-stats.mapper";
import { workerOperationsService } from "./worker-operations.service";
import { getWorkerRuntime } from "./worker-runtime";

const TIME_OF_DAY_REGEX = /^\d{2}:\d{2}$/;

export class WorkerSchedulerService extends BaseService {
	private readonly customTriggers = new Map<string, TaskTrigger[]>();
	private lastEvaluatedAt?: Date | undefined;
	private hasRunStartupTriggers = false;
	private isEvaluating = false;
	private checkTimer?: Timer | undefined;

	constructor() {
		super("WorkerSchedulerService");
	}

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

		if (isStartup) {
			for (const def of definitions) {
				const triggers = this.getTriggersForWorker(def.id);
				if (triggers.some((t) => t.type === "startup")) {
					this.logger.info("Triggering worker on startup", { workerId: def.id });
					await this.enqueueScheduled(def.id, `startup:${currentMinute}`, def.schedule?.data);
				}
			}
		}

		// Deadline-based scheduling: every worker carries a persisted nextRunAt.
		// A deadline missed during downtime fires exactly once here (no minute
		// replay, no flood), then advances past `now`.
		const scheduleRows = await workerSchedulesRepository.getAllSchedules();
		for (const def of definitions) {
			const row = scheduleRows.get(def.id);
			if (row && !row.isEnabled) continue;

			const triggers = this.getTriggersForWorker(def.id);
			const cron = def.schedule?.cron;

			const due = row?.nextRunAt ?? null;
			if (due === null) {
				// First pass for this worker — arm the deadline without firing.
				await workerSchedulesRepository.setNextRunAt(def.id, computeNextRunAt(triggers, cron, now));
				continue;
			}

			if (due.getTime() > now.getTime()) continue;

			this.logger.debug("Triggering scheduled worker", { workerId: def.id, dueAt: due.toISOString() });
			await this.enqueueScheduled(def.id, `schedule:${def.id}:${due.getTime()}`, def.schedule?.data, def.schedule?.operationId);
			await workerSchedulesRepository.setNextRunAt(def.id, computeNextRunAt(triggers, cron, now));
		}
	}

	private async enqueueScheduled(workerId: string, dedupeKey: string, data: unknown = {}, operationId?: string): Promise<void> {
		try {
			// A dedupe hit inserts nothing; creating the operation first would leave a
			// phantom "pending" operation with zero jobs. Pre-check the active job.
			if (!operationId) {
				const existing = await getWorkerRuntime().queue.findActive(workerId, dedupeKey);
				if (existing) return;
			}

			let opId = operationId;
			let createdOperation = false;
			if (!opId) {
				const op = await workerOperationsService.create({
					type: workerId,
					reference: { type: "worker", id: workerId },
				});
				opId = op.id;
				createdOperation = true;
			}

			try {
				await getWorkerRuntime().queue.enqueue(workerId, data, { dedupeKey, operationId: opId });
			} catch (error) {
				if (createdOperation)
					await workerOperationsService.remove(opId).catch(() => {
						// intentionally empty
					});

				throw error;
			}
		} catch (error) {
			this.logger.warn("Could not enqueue scheduled worker task", { workerId, dedupeKey, error });
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
			throw new NotFoundError(`Worker "${workerId}" was not found`);
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

	async runWorkerManually(workerId: string, data: unknown = {}): Promise<{ success: true; jobId: string; operationId?: string }> {
		const def = getWorkerRuntime().registry.get(workerId);
		if (!def) throw new NotFoundError(`Worker "${workerId}" was not found`);

		const active = await getWorkerRuntime().queue.findActive(workerId, `manual:${workerId}`);
		if (active) {
			throw new ConflictError(`Worker "${workerId}" already has a pending or running manual task`);
		}

		const operation = await workerOperationsService.create({
			type: workerId,
			reference: { type: "worker", id: workerId },
		});

		try {
			const job = await getWorkerRuntime().queue.enqueue(workerId, data, {
				dedupeKey: `manual:${workerId}`,
				// Negative = highest priority (claim sorts ascending).
				priority: -10,
				operationId: operation.id,
			});

			return { success: true, jobId: job.id, operationId: operation.id };
		} catch (error) {
			// Do not leave a dangling operation when the enqueue is rejected.
			await workerOperationsService.remove(operation.id).catch(() => {
				// intentionally empty
			});
			throw error;
		}
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
				if (error instanceof ConflictError) {
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
			throw new NotFoundError(`Worker "${workerId}" was not found`);
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
			statsMap.set(def.id, {
				workerId: def.id,
				concurrency: def.concurrency ?? 1,
				timeoutMs: def.timeoutMs ?? MINUTE,
				waiting: 0,
				active: 0,
				completed: 0,
				failed: 0,
			});
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
				stats: statsMap.get(def.id) ?? {
					workerId: def.id,
					concurrency: 1,
					timeoutMs: MINUTE,
					waiting: 0,
					active: 0,
					completed: 0,
					failed: 0,
				},
				triggers,
				...pickDefined({ description: def.description, lastExecution }),
			});
		}

		return summaries;
	}

	private validateTrigger(trigger: TaskTrigger, workerId: string, index: number): void {
		if (trigger.type === "daily" || trigger.type === "weekly") {
			if (!(trigger.timeOfDay && TIME_OF_DAY_REGEX.test(trigger.timeOfDay))) {
				throw new ValidationError(`Worker "${workerId}" trigger[${index}] (${trigger.type}) requires valid "timeOfDay" (HH:MM)`);
			}
		}

		if (trigger.type === "weekly") {
			if (trigger.dayOfWeek === undefined || trigger.dayOfWeek < 0 || trigger.dayOfWeek > 6) {
				throw new ValidationError(`Worker "${workerId}" trigger[${index}] (weekly) requires valid "dayOfWeek" (0-6)`);
			}
		}

		if (trigger.type === "interval") {
			if (!trigger.intervalMinutes || trigger.intervalMinutes < 1) {
				throw new ValidationError(`Worker "${workerId}" trigger[${index}] (interval) requires "intervalMinutes" >= 1`);
			}
		}
	}
}

export const workerSchedulerService = new WorkerSchedulerService();
