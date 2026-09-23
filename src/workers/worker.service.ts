import type { AddWorkerItemOptions, WorkerDefinition, WorkerJob as WorkerItemContract, WorkerQueueStats } from "@sdk/common";
import { v7 as uuidv7 } from "uuid";
import type { ActiveWorkerItem, WorkerItem } from "@/database/repositories/worker.repository";
import type { WorkerOperationRecord, WorkerOperationStatus } from "@/database/repositories/worker-operation.repository";
import { resourceAllocator } from "@/system/resource-allocator";
import { serverRescueService } from "@/system/server-rescue.service";
import { BaseService } from "@/utils/base-service";
import { detach } from "@/utils/promise.utils";
import { type WorkerOperationsService, workerOperationsService } from "./core/worker-operations.service";
import { WorkerPollingService } from "./core/worker-polling.service";
import { WorkerExecutionPoolService } from "./core/worker-pool.service";
import { WorkerQueueService } from "./core/worker-queue.service";
import { WorkerRegistryService } from "./core/worker-registry.service";
import { setWorkerRuntime } from "./core/worker-runtime";
import { type WorkerSchedulerService, workerSchedulerService } from "./core/worker-scheduler.service";
import { WorkerWatchdogService } from "./core/worker-watchdog.service";
import { toJobContract } from "./utils/worker-stats.mapper";

class WorkerService extends BaseService {
	readonly registry: WorkerRegistryService;
	readonly pool: WorkerExecutionPoolService;
	readonly queue: WorkerQueueService;
	readonly operations: WorkerOperationsService = workerOperationsService;
	readonly scheduler: WorkerSchedulerService = workerSchedulerService;
	readonly polling: WorkerPollingService;
	readonly watchdog: WorkerWatchdogService;

	private readonly runnerId = `server-${process.pid}-${uuidv7()}`;
	private initialized = false;

	constructor() {
		super("WorkerService");
		// Init services
		this.registry = new WorkerRegistryService();
		this.pool = new WorkerExecutionPoolService();
		this.queue = new WorkerQueueService();
		this.polling = new WorkerPollingService();
		this.watchdog = new WorkerWatchdogService();

		// Hand the subsystems to the core services without them importing this
		// module back (that cycle caused a BaseService TDZ at module load).
		setWorkerRuntime({ registry: this.registry, pool: this.pool, queue: this.queue });

		this.pool.setRunnerId(this.runnerId);
		this.polling.setRunnerId(this.runnerId);
		this.watchdog.setRunnerId(this.runnerId);

		// Wire up events across subsystems
		this.pool.onSlotFreed(() => this.polling.triggerPoll());
		this.queue.onEnqueue(() => this.polling.triggerPoll());
		this.watchdog.registerPolling({
			getLastPollAt: () => this.polling.lastPollTimestamp,
			onStallDetected: () => this.polling.triggerPoll(),
			onEscalated: () => this.polling.recoverFromStall(),
		});

		// Server rescue escalation: abort running tasks of every non-protected worker
		// and put them back into the queue with attempts preserved — the work itself
		// was healthy, the server just needs the capacity back. Protected workers
		// (playback) keep running; pending tasks stay queued and are picked up again
		// once rescue releases.
		serverRescueService.registerActions({
			cancelBackgroundTasks: () => {
				for (const definition of this.registry.getAll()) {
					if (serverRescueService.isWorkerProtected(definition.id)) continue;

					this.pool.requeueAllForWorker(definition.id);
				}
			},
		});

		resourceAllocator.registerActiveWorkersProvider(() => this.pool.getRunningCounts());
	}

	async initialize(workers?: WorkerDefinition[]): Promise<void> {
		if (this.initialized) return;

		if (workers) {
			for (const definition of workers) {
				this.registerWorker(definition);
			}
		}

		await this.watchdog.recoverOrphaned();
		this.polling.start();
		this.watchdog.start();
		await this.scheduler.init();

		this.initialized = true;
		this.logger.info("Worker service initialized", { runnerId: this.runnerId, workers: this.registry.size });
	}

	async shutdown(): Promise<void> {
		if (!this.initialized) return;

		this.initialized = false;
		this.scheduler.dispose();
		this.watchdog.stop();
		this.polling.stop();
		this.pool.cancelAll();
		await this.pool.drain();

		this.logger.info("Worker service shut down");
	}

	registerWorker<TData = unknown, TResult = unknown>(definition: WorkerDefinition<TData, TResult>): void {
		this.registry.register(definition);
		if (this.initialized) this.polling.triggerPoll();
	}

	unregisterWorker(workerId: string): boolean {
		const removed = this.registry.unregister(workerId);
		if (!removed) return false;

		// Polling skips unregistered worker ids, so queued tasks would linger forever
		// until the plugin re-enables — cancel in-flight and pending tasks explicitly.
		this.pool.cancelAllForWorker(workerId);
		detach(
			(async () => {
				try {
					await this.cancelAllPending(workerId);
				} catch (error) {
					this.logger.error("Failed to cancel pending jobs", error, { workerId });
				}
			})(),
		);

		return true;
	}

	getDefinitions(): WorkerDefinition[] {
		return this.registry.getAll();
	}

	addItem(workerId: string, data: unknown, options: AddWorkerItemOptions = {}): Promise<WorkerItem> {
		return this.queue.enqueue(workerId, data, options);
	}

	addItems(workerId: string, entries: Array<{ data: unknown; options?: AddWorkerItemOptions }>): Promise<WorkerItem[]> {
		return this.queue.enqueueMany(workerId, entries);
	}

	findActiveItem(workerId: string, dedupeKey: string): Promise<ActiveWorkerItem | undefined> {
		return this.queue.findActive(workerId, dedupeKey);
	}

	findActiveItems(workerId: string, dedupeKeys: readonly string[]): Promise<ActiveWorkerItem[]> {
		return this.queue.findActiveMany(workerId, dedupeKeys);
	}

	async getItem(id: string): Promise<WorkerItemContract | undefined> {
		const item = await this.queue.getJob(id);

		return item ? toJobContract(item) : undefined;
	}

	async listItems(limit = 100, workerId?: string): Promise<WorkerItemContract[]> {
		const items = await this.queue.listJobs(limit, workerId);

		return items.map((i) => toJobContract(i));
	}

	async cancelItem(id: string): Promise<boolean> {
		const item = await this.queue.getJob(id);
		if (!item) return false;

		if (item.status === "running") {
			this.pool.cancel(id);
		}

		return this.queue.cancelJob(id);
	}

	cancelAllPending(workerId?: string): Promise<number> {
		return this.queue.cancelAllPending(workerId);
	}

	/**
	 * Awaits in-flight executions for the given workers (already cancelled by
	 * `unregisterWorker`) and settles their pending jobs. Used before a plugin's
	 * stored data is deleted so a straggling handler cannot write against it.
	 */
	async drainWorkers(workerIds: readonly string[], timeoutMs: number): Promise<void> {
		if (workerIds.length === 0) return;

		await this.pool.drainWorkers(workerIds, timeoutMs);
		await Promise.all(
			workerIds.map((workerId) =>
				this.cancelAllPending(workerId).catch(() => {
					// Best-effort: an already-removed worker has nothing to cancel.
					return 0;
				}),
			),
		);
	}

	async purgeHistory(
		options: { status?: "completed" | "failed" | "cancelled" | "all_terminal" | undefined; olderThanDays?: number | undefined } = {},
	): Promise<{ deletedJobsCount: number; deletedOperationsCount: number }> {
		// Operations and standalone jobs purge independently (no FK between the
		// tables), so both DELETE scans can run concurrently.
		const [opResult, standaloneJobsDeleted] = await Promise.all([this.operations.purgeHistory(options), this.queue.purgeHistory(options)]);

		return {
			deletedJobsCount: opResult.deletedJobsCount + standaloneJobsDeleted,
			deletedOperationsCount: opResult.deletedOperationsCount,
		};
	}

	createOperation(input: { type: string; reference?: { type: string; id: string }; error?: string }): Promise<WorkerOperationRecord> {
		return this.operations.create(input);
	}

	/**
	 * Creates an operation, runs `enqueue` (which should attach the enqueue to
	 * the operation via `options.operationId`), and removes the operation again
	 * when the enqueue fails — the shared variant of the try/removeOperation
	 * cleanup that call sites previously duplicated.
	 */
	async enqueueUnderOperation<T>(
		input: { type: string; reference?: { type: string; id: string } },
		enqueue: (operationId: string) => Promise<T>,
	): Promise<{ operationId: string; result: T }> {
		const operation = await this.createOperation(input);
		try {
			const result = await enqueue(operation.id);

			return { operationId: operation.id, result };
		} catch (error) {
			await this.removeOperation(operation.id);
			throw error;
		}
	}

	getOperation(id: string) {
		return this.operations.getById(id);
	}

	async removeOperation(id: string): Promise<void> {
		await this.operations.remove(id);
	}

	listOperations(
		options: { status?: WorkerOperationStatus | "active" | undefined; page?: number | undefined; limit?: number | undefined } = {},
	) {
		return this.operations.list(options);
	}

	getOperationItems(
		id: string,
		options: {
			status?: "pending" | "running" | "completed" | "failed" | "cancelled" | undefined;
			search?: string | undefined;
			page?: number | undefined;
			limit?: number | undefined;
		} = {},
	) {
		return this.operations.getOperationJobs(id, options);
	}

	cancelOperation(id: string): Promise<boolean> {
		return this.operations.cancel(id);
	}

	cancelAllOperations(): Promise<number> {
		return this.operations.cancelAll();
	}

	resumeOperation(id: string): Promise<{ resumed: number }> {
		return this.operations.resume(id);
	}

	async getStats(): Promise<WorkerQueueStats[]> {
		const summaries = await this.scheduler.listWorkerSummaries();

		return summaries.map((s) => s.stats);
	}
}

export const workerService = new WorkerService();
