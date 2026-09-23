import type { WorkerDefinition, WorkerHandlerContext } from "@reelvault/sdk/common";
import { type WorkerItem, workerJobRepository } from "@/database/repositories/worker.repository";
import { workerOperationRepository } from "@/database/repositories/worker-operation.repository";
import { type WorkerExecutionRecord, workerSchedulesRepository } from "@/database/repositories/worker-schedules.repository";
import { realtimeService } from "@/modules/realtime";
import { MINUTE } from "@/server.constants";
import { BaseService } from "@/utils/base-service";
import { errorMessage } from "@/utils/errors";
import { safeParseJson } from "@/utils/file.utils";
import { detach } from "@/utils/promise.utils";
import { getRetryDelay } from "../utils/worker-policy.utils";

interface ActiveExecution {
	workerId: string;
	/** The claimed row — used to finalize the DB state if the handler ignores its abort. */
	item: WorkerItem;
	controller: AbortController;
	timeoutTimer?: Timer | undefined;
	graceTimer?: Timer | undefined;
	startedAt: number;
	promise: Promise<void>;
	/** Why the execution was aborted — decides whether the task is requeued, cancelled or retried. */
	abortReason?: "cancel" | "rescue" | "shutdown" | "timeout" | undefined;
	/** Last time updateProgress actually hit the database (throttle window anchor). */
	lastProgressWriteAt?: number | undefined;
}

/** How long a handler may ignore the abort signal after a timeout before its slot is reclaimed. */
const FORCE_RELEASE_GRACE_MS = 10_000;
/** Bound on `drain()` so a stuck handler cannot stall shutdown past the force-exit timer. */
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_WORKER_TIMEOUT_MS = 5 * MINUTE;
/** Handlers report progress per processed item; DB writes are throttled to this cadence. */
const PROGRESS_WRITE_MIN_INTERVAL_MS = 1_000;

export class WorkerExecutionPoolService extends BaseService {
	private readonly running = new Map<string, ActiveExecution>();
	private readonly runningCountByWorker = new Map<string, number>();
	private runnerId = "default-runner";
	private onSlotFreedCallback?: (() => void) | undefined;

	constructor() {
		super("WorkerExecutionPoolService");
	}

	setRunnerId(runnerId: string): void {
		this.runnerId = runnerId;
	}

	onSlotFreed(callback: () => void): void {
		this.onSlotFreedCallback = callback;
	}

	get totalRunningCount(): number {
		return this.running.size;
	}

	runningCountFor(workerId: string): number {
		return this.runningCountByWorker.get(workerId) ?? 0;
	}

	getRunningCounts(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const [id, count] of this.runningCountByWorker) {
			if (count > 0) counts[id] = count;
		}

		return counts;
	}

	start(definition: WorkerDefinition, item: WorkerItem): void {
		const controller = new AbortController();
		const timeoutMs = definition.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
		// `promise` is a placeholder: runExecution needs the `exec` handle, so it is
		// assigned right after construction (and before the timeout could fire).
		const exec: ActiveExecution = { workerId: definition.id, item, controller, startedAt: Date.now(), promise: Promise.resolve() };

		this.armTimeout(exec, item.id, timeoutMs);

		exec.promise = this.runExecution(definition, item, controller, exec);
		this.running.set(item.id, exec);
		const prev = this.runningCountByWorker.get(definition.id) ?? 0;
		this.runningCountByWorker.set(definition.id, prev + 1);
	}

	private armTimeout(exec: ActiveExecution, jobId: string, timeoutMs: number): void {
		if (exec.timeoutTimer) clearTimeout(exec.timeoutTimer);

		exec.timeoutTimer = setTimeout(() => {
			this.logger.warn("Worker task execution timed out, aborting", { workerId: exec.workerId, taskId: jobId, timeoutMs });
			exec.abortReason = "timeout";
			exec.controller.abort(new Error(`Execution timed out after ${timeoutMs}ms`));
			this.scheduleForceRelease(exec, jobId, "timeout grace period");
		}, timeoutMs);
	}

	/**
	 * Re-arms the abort timer to fire `additionalMs` from now. Handlers of
	 * workload-dependent workers call this as they make progress, so the fixed
	 * definition timeout acts as a stall guard instead of a hard total cap.
	 */
	extendTimeout(jobId: string, additionalMs: number): void {
		if (!(additionalMs > 0)) return;

		const exec = this.running.get(jobId);
		if (!exec) return;

		this.armTimeout(exec, jobId, additionalMs);
	}

	private async runExecution(
		definition: WorkerDefinition,
		item: WorkerItem,
		controller: AbortController,
		exec: ActiveExecution,
	): Promise<void> {
		const data = safeParseJson(item.data) ?? item.data;
		const startedAt = new Date();
		const context = this.buildWorkerContext(item, data, controller, exec);

		try {
			const result = await definition.handler(context);
			this.clearTimers(exec);
			const durationMs = Date.now() - startedAt.getTime();
			await this.handleTaskSuccess(item, exec, startedAt, durationMs, result);
		} catch (error) {
			this.clearTimers(exec);
			const errorMsg = errorMessage(error);
			const durationMs = Date.now() - startedAt.getTime();
			await this.handleTaskFailure(item, exec, startedAt, durationMs, errorMsg);
		} finally {
			this.clearTimers(exec);
			this.releaseSlot(item.id, exec);
		}
	}

	private buildWorkerContext(item: WorkerItem, data: unknown, controller: AbortController, exec: ActiveExecution): WorkerHandlerContext {
		return {
			taskId: item.id,
			workerId: item.workerId,
			operationId: item.operationId ?? undefined,
			data,
			attempt: item.attempts,
			signal: controller.signal,
			logger: this.logger,
			updateProgress: async (percent: number) => {
				const now = Date.now();
				if (percent < 100 && now - (exec.lastProgressWriteAt ?? 0) < PROGRESS_WRITE_MIN_INTERVAL_MS) return;

				exec.lastProgressWriteAt = now;
				await Promise.all([
					workerJobRepository.updateProgress(item.id, percent, item.claimToken ?? undefined),
					item.operationId ? workerOperationRepository.updateProgress(item.operationId, percent) : undefined,
				]);
			},
			extendTimeout: (additionalMs: number) => this.extendTimeout(item.id, additionalMs),
		};
	}

	private async handleTaskSuccess(
		item: WorkerItem,
		exec: ActiveExecution,
		startedAt: Date,
		durationMs: number,
		result: unknown,
	): Promise<void> {
		if (await this.handleAbortAfterCompletion(item, exec, startedAt, durationMs)) return;

		await workerJobRepository.complete(item.id, this.runnerId, JSON.stringify(result ?? null), item.claimToken ?? undefined);
		await this.recordScheduleExecution(item.workerId, {
			status: "completed",
			startedAt,
			completedAt: new Date(),
			durationMs,
		});
		realtimeService.broadcast("worker:job:completed", {
			jobId: item.id,
			workerId: item.workerId,
			type: item.workerId,
		});
	}

	private async handleTaskFailure(
		item: WorkerItem,
		exec: ActiveExecution,
		startedAt: Date,
		durationMs: number,
		errorMsg: string,
	): Promise<void> {
		if (await this.handleAbortAfterCompletion(item, exec, startedAt, durationMs, errorMsg)) return;

		if (item.attempts < item.maxAttempts) {
			const delayMs = getRetryDelay({
				attempts: item.attempts,
				backoffType: item.backoffType,
				backoffDelayMs: item.backoffDelayMs,
			});
			const runAt = new Date(Date.now() + delayMs);
			this.logger.warn("Worker task failed, scheduling retry", {
				workerId: item.workerId,
				taskId: item.id,
				attempt: item.attempts,
				maxAttempts: item.maxAttempts,
				retryAt: runAt.toISOString(),
				error: errorMsg,
			});
			await workerJobRepository.retry(item.id, this.runnerId, runAt, errorMsg, item.claimToken ?? undefined);
		} else {
			this.logger.error("Worker task permanently failed", {
				workerId: item.workerId,
				taskId: item.id,
				attempt: item.attempts,
				error: errorMsg,
			});
			await Promise.all([
				workerJobRepository.fail(item.id, this.runnerId, errorMsg, item.claimToken ?? undefined),
				this.recordScheduleExecution(item.workerId, {
					status: "failed",
					startedAt,
					completedAt: new Date(),
					durationMs,
					error: errorMsg,
				}),
			]);
		}
	}

	private releaseSlot(jobId: string, exec: ActiveExecution): void {
		if (this.running.get(jobId) === exec) {
			this.running.delete(jobId);
			const cur = this.runningCountByWorker.get(exec.workerId);
			if (cur !== undefined) this.runningCountByWorker.set(exec.workerId, cur - 1);

			this.onSlotFreedCallback?.();
		}
	}

	/** Clear both the timeout and grace-period timers on an execution. */
	private clearTimers(exec: ActiveExecution): void {
		if (exec.timeoutTimer) clearTimeout(exec.timeoutTimer);

		if (exec.graceTimer) clearTimeout(exec.graceTimer);
	}

	/**
	 * Arm a safety-net timer that forcibly releases the slot if the handler
	 * ignores the abort signal.  Used after timeout and explicit cancel.
	 */
	private scheduleForceRelease(exec: ActiveExecution, jobId: string, reason: string): void {
		exec.graceTimer = setTimeout(() => {
			if (this.running.get(jobId) !== exec) return;

			this.logger.warn(`Worker task still running after ${reason}, forcing slot release`, {
				workerId: exec.workerId,
				taskId: jobId,
				graceMs: FORCE_RELEASE_GRACE_MS,
			});
			this.releaseSlot(jobId, exec);
			// The handler ignored its abort. Finalize the DB row now so recovery cannot
			// re-claim a still-`running` row and run the task a second time. Race the
			// row's own outcome only when the handler eventually settles.
			detach(this.finalizeAbandonedExecution(exec));
		}, FORCE_RELEASE_GRACE_MS);
	}

	/**
	 * Marks the row of a handler that ignored its abort. `cancel` → cancelled,
	 * `timeout` → failed (a non-cooperative timeout must not be retried — the old
	 * handler may still be alive), `rescue`/`shutdown` → requeued. All repository
	 * mutations are guarded on `status='running'`, so a handler that settles first
	 * wins and this becomes a no-op.
	 */
	private async finalizeAbandonedExecution(exec: ActiveExecution): Promise<void> {
		const { id } = exec.item;
		const claimToken = exec.item.claimToken ?? undefined;
		try {
			if (exec.abortReason === "cancel") {
				await workerJobRepository.cancelRunning(id, claimToken);

				return;
			}

			if (exec.abortReason === "timeout") {
				await workerJobRepository.fail(id, this.runnerId, "Execution timed out and did not stop after the grace period", claimToken);

				return;
			}

			if (exec.abortReason === "rescue" || exec.abortReason === "shutdown") {
				await workerJobRepository.requeueRunning(id, this.runnerId, `Requeued after ${exec.abortReason} force-release`, claimToken);
			}
		} catch (error) {
			this.logger.warn("Failed to finalize an abandoned worker execution", {
				workerId: exec.workerId,
				taskId: id,
				error: errorMessage(error),
			});
		}
	}

	/**
	 * Handle the abort-reason dispatch shared between the success and catch
	 * paths of runExecution.  Returns `true` when the caller should skip
	 * its remaining branches (the abort was fully handled).
	 */
	private async handleAbortAfterCompletion(
		item: WorkerItem,
		exec: ActiveExecution,
		startedAt: Date,
		durationMs: number,
		errorMsg?: string,
	): Promise<boolean> {
		if (!exec.abortReason) return false;

		const reason = exec.abortReason;
		const controllerSignalAborted = exec.controller.signal.aborted;

		if (controllerSignalAborted && (reason === "rescue" || reason === "shutdown")) {
			const note = errorMsg ? `Requeued by ${reason}: ${errorMsg}` : `Requeued by ${reason}`;
			await workerJobRepository.requeueRunning(item.id, this.runnerId, note, item.claimToken ?? undefined);

			return true;
		}

		if (controllerSignalAborted && reason === "cancel") {
			await Promise.all([
				workerJobRepository.cancelRunning(item.id, item.claimToken ?? undefined),
				this.recordScheduleExecution(item.workerId, {
					status: "cancelled",
					startedAt,
					completedAt: new Date(),
					durationMs,
					...(errorMsg ? { error: errorMsg } : {}),
				}),
			]);

			return true;
		}

		return false;
	}

	/** Schedule bookkeeping must never decide the task outcome: the job row is
	 * already terminal (completed/failed/cancelled), so a failed schedule write
	 * only loses "last run" stats — it must not trigger a retry. */
	private async recordScheduleExecution(workerId: string, record: WorkerExecutionRecord): Promise<void> {
		try {
			await workerSchedulesRepository.updateExecution(workerId, record);
		} catch (error) {
			this.logger.warn("Worker schedule update failed — task result unaffected", { workerId, error: errorMessage(error) });
		}
	}

	getActiveJobIds(): string[] {
		return [...this.running.keys()];
	}

	cancel(jobId: string): boolean {
		const exec = this.running.get(jobId);
		if (!exec) return false;

		this.clearTimers(exec);
		exec.abortReason = "cancel";
		exec.controller.abort(new Error("Cancelled by user or system"));
		this.scheduleForceRelease(exec, jobId, "cancel");

		return true;
	}

	cancelAllForWorker(workerId: string, options?: { requeue?: boolean }): number {
		let count = 0;
		for (const [jobId, exec] of this.running) {
			if (exec.workerId !== workerId) continue;

			this.clearTimers(exec);
			exec.abortReason = options?.requeue === true ? "rescue" : "cancel";
			exec.controller.abort(new Error(`Cancelled worker "${workerId}" by user or system`));
			// Without a force-release a handler that ignores the abort keeps the slot
			// forever (rescue included), wedging the worker at 0 free concurrency.
			this.scheduleForceRelease(exec, jobId, options?.requeue === true ? "rescue" : "cancel");
			count++;
		}

		return count;
	}

	/** Server rescue: abort non-protected workers and put their running tasks back into the queue. */
	requeueAllForWorker(workerId: string): number {
		return this.cancelAllForWorker(workerId, { requeue: true });
	}

	cancelAll(): void {
		for (const [jobId, exec] of this.running) {
			this.clearTimers(exec);
			exec.abortReason = "shutdown";
			exec.controller.abort(new Error("Worker engine shutting down"));
			this.scheduleForceRelease(exec, jobId, "shutdown");
		}
	}

	async drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
		const inflight = [...this.running.values()].map((exec) => exec.promise);
		if (inflight.length === 0) return;

		// Bounded: a handler that ignores the abort must not stall shutdown until the
		// global force-exit timer.
		await Promise.race([
			Promise.allSettled(inflight),
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, timeoutMs);
				timer.unref();
			}),
		]);
	}

	/**
	 * Waits for in-flight executions of the given workers to settle, bounded by
	 * `timeoutMs` so a handler that ignores its abort signal cannot block a
	 * plugin uninstall forever.
	 */
	async drainWorkers(workerIds: readonly string[], timeoutMs: number): Promise<void> {
		const ids = new Set(workerIds);
		const inflight = [...this.running.values()].filter((exec) => ids.has(exec.workerId)).map((exec) => exec.promise);
		if (inflight.length === 0) return;

		await Promise.race([
			Promise.allSettled(inflight),
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, timeoutMs);
				timer.unref();
			}),
		]);
	}
}
