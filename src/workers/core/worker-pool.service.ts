import type { WorkerDefinition, WorkerHandlerContext } from "@reelvault/sdk/common";
import { MINUTE } from "@/config/server/server.constants";
import { realtimeService } from "@/modules/realtime/realtime.service";
import { errorMessage } from "@/utils/domain.errors";
import { safeParseJson } from "@/utils/file.utils";
import { createLogger } from "@/utils/logger.utils";
import { detach } from "@/utils/promise.utils";
import { getRetryDelay } from "@/workers/utils/worker-policy.utils";
import { type WorkerExecutionRecord, type WorkerItem, workerDependencies } from "@/workers/worker.ports";

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
	abortReason?: ExecutionAbortReason | undefined;
	/** Last time updateProgress actually hit the database (throttle window anchor). */
	lastProgressWriteAt?: number | undefined;
}

type ExecutionAbortReason = "cancel" | "rescue" | "shutdown" | "timeout";

/** How long a handler may ignore the abort signal after a timeout before its slot is reclaimed. */
const FORCE_RELEASE_GRACE_MS = 10_000;
/** Bound on `drain()` so a stuck handler cannot stall shutdown past the force-exit timer. */
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_WORKER_TIMEOUT_MS = 5 * MINUTE;
/** Handlers report progress per processed item; DB writes are throttled to this cadence. */
const PROGRESS_WRITE_MIN_INTERVAL_MS = 1_000;

export class WorkerExecutionPoolService {
	readonly serviceName = "WorkerExecutionPoolService";
	readonly logger = createLogger("WorkerExecutionPoolService");

	private readonly running = new Map<string, ActiveExecution>();
	private readonly runningCountByWorker = new Map<string, number>();
	private runnerId = "default-runner";
	private onSlotFreedCallback?: (() => void) | undefined;

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

		// The polling loop does not await executions (drain does); a failure inside
		// the finalize path must still not surface as an unhandled rejection.
		detach(
			(async () => {
				try {
					await exec.promise;
				} catch (error) {
					this.logger.error("Worker execution failed to finalize", error, { workerId: definition.id, taskId: item.id });
				}
			})(),
		);
	}

	private armTimeout(exec: ActiveExecution, jobId: string, timeoutMs: number): void {
		if (exec.timeoutTimer) clearTimeout(exec.timeoutTimer);

		exec.timeoutTimer = setTimeout(() => {
			this.logger.warn("Worker task execution timed out, aborting", { workerId: exec.workerId, taskId: jobId, timeoutMs });
			this.abortExecution(exec, jobId, "timeout", `Execution timed out after ${timeoutMs}ms`, "timeout grace period");
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
		const parsed = safeParseJson(item.data);
		if (!parsed) {
			// The stored payload is not the JSON every definition expects — handlers
			// may still cope (string payloads), but the drift must be visible.
			this.logger.warn("Worker task payload is not valid JSON — passing it through raw", {
				workerId: exec.workerId,
				taskId: item.id,
			});
		}
		const data = parsed ?? item.data;
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
					workerDependencies().jobs.updateProgress(item.id, percent, item.claimToken ?? undefined),
					item.operationId ? workerDependencies().operations.updateProgress(item.operationId, percent) : undefined,
				]);
				// Same 1s throttle as the DB write — a small WS frame instead of the
				// client polling operations every few seconds.
				realtimeService.broadcastToAdmins("worker:progress", {
					jobId: item.id,
					operationId: item.operationId ?? undefined,
					workerId: item.workerId,
					percent,
				});
			},
			// Bound to this execution: a force-released handler that keeps calling
			// extendTimeout must not re-arm the timer of a newer attempt of the job.
			extendTimeout: (additionalMs: number) => {
				if (this.running.get(item.id) === exec) this.extendTimeout(item.id, additionalMs);
			},
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

		await workerDependencies().jobs.complete(item.id, this.runnerId, JSON.stringify(result ?? null), item.claimToken ?? undefined);
		await this.recordScheduleExecution(item.workerId, {
			status: "completed",
			startedAt,
			completedAt: new Date(),
			durationMs,
		});
		realtimeService.broadcastToAdmins("worker:job:completed", {
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
			await workerDependencies().jobs.retry(item.id, this.runnerId, runAt, errorMsg, item.claimToken ?? undefined);
		} else {
			this.logger.error("Worker task permanently failed", {
				workerId: item.workerId,
				taskId: item.id,
				attempt: item.attempts,
				error: errorMsg,
			});
			await Promise.all([
				workerDependencies().jobs.fail(item.id, this.runnerId, errorMsg, item.claimToken ?? undefined),
				this.recordScheduleExecution(item.workerId, {
					status: "failed",
					startedAt,
					completedAt: new Date(),
					durationMs,
					error: errorMsg,
				}),
			]);
			workerDependencies().services.adminFailureNotifications.notifyWorkerFailed(item.workerId, errorMsg);
		}
	}

	private releaseSlot(jobId: string, exec: ActiveExecution): void {
		if (this.running.get(jobId) === exec) {
			this.running.delete(jobId);
			const cur = this.runningCountByWorker.get(exec.workerId);
			if (cur !== undefined) {
				// Drop the entry at zero: a worker id that never runs again would
				// otherwise stay in the map forever, and the resource allocator
				// reads this map on every monitoring tick.
				if (cur <= 1) this.runningCountByWorker.delete(exec.workerId);
				else this.runningCountByWorker.set(exec.workerId, cur - 1);
			}

			this.onSlotFreedCallback?.();
		}
	}

	/** Clear both the timeout and grace-period timers on an execution. */
	private clearTimers(exec: ActiveExecution): void {
		if (exec.timeoutTimer) clearTimeout(exec.timeoutTimer);

		if (exec.graceTimer) clearTimeout(exec.graceTimer);
	}

	/** Aborts a running execution and arms the grace timer that reclaims its slot if the handler ignores the abort. */
	private abortExecution(
		exec: ActiveExecution,
		jobId: string,
		reason: ExecutionAbortReason,
		message: string,
		forceReleaseReason: string,
	): void {
		this.clearTimers(exec);
		exec.abortReason = reason;
		exec.controller.abort(new Error(message));
		this.scheduleForceRelease(exec, jobId, forceReleaseReason);
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
				await workerDependencies().jobs.cancelRunning(id, claimToken);

				return;
			}

			if (exec.abortReason === "timeout") {
				await workerDependencies().jobs.fail(id, this.runnerId, "Execution timed out and did not stop after the grace period", claimToken);

				return;
			}

			if (exec.abortReason === "rescue" || exec.abortReason === "shutdown") {
				await workerDependencies().jobs.requeueRunning(id, this.runnerId, `Requeued after ${exec.abortReason} force-release`, claimToken);
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
			await workerDependencies().jobs.requeueRunning(item.id, this.runnerId, note, item.claimToken ?? undefined);

			return true;
		}

		if (controllerSignalAborted && reason === "cancel") {
			await Promise.all([
				workerDependencies().jobs.cancelRunning(item.id, item.claimToken ?? undefined),
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
			await workerDependencies().schedules.updateExecution(workerId, record);
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

		this.abortExecution(exec, jobId, "cancel", "Cancelled by user or system", "cancel");

		return true;
	}

	cancelAllForWorker(workerId: string, options?: { requeue?: boolean }): number {
		let count = 0;
		const requeue = options?.requeue === true;
		for (const [jobId, exec] of this.running) {
			if (exec.workerId !== workerId) continue;

			// Without a force-release a handler that ignores the abort keeps the slot
			// forever (rescue included), wedging the worker at 0 free concurrency.
			this.abortExecution(
				exec,
				jobId,
				requeue ? "rescue" : "cancel",
				`Cancelled worker "${workerId}" by user or system`,
				requeue ? "rescue" : "cancel",
			);
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
			this.abortExecution(exec, jobId, "shutdown", "Worker engine shutting down", "shutdown");
		}
	}

	/**
	 * Waits for in-flight executions to settle, bounded by `timeoutMs` so a
	 * handler that ignores its abort signal cannot block shutdown (or a plugin
	 * uninstall) forever. When `workerIds` is given only those workers are
	 * awaited.
	 */
	async drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS, workerIds?: readonly string[]): Promise<void> {
		const ids = workerIds ? new Set(workerIds) : null;
		const inflight = [...this.running.values()].filter((exec) => !ids || ids.has(exec.workerId)).map((exec) => exec.promise);
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
}
