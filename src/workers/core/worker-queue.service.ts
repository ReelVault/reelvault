import type { AddWorkerItemOptions, WorkerDefinition } from "@reelvault/sdk/common";
import { serverConfig } from "@/config/server/server.config";
import { DomainError } from "@/utils/domain.errors";
import { createLogger } from "@/utils/logger.utils";
import { type TerminalPurgeRequest, terminalPurgeFilter } from "@/workers/utils/worker-purge.utils";
import { type ActiveWorkerItem, type EnqueueWorkerItemInput, type WorkerItem, workerDependencies } from "@/workers/worker.ports";
import { getWorkerRuntime } from "./worker.runtime";
import { anyAttachedToOperation, attachedToOperation, enqueueWithOperation } from "./worker-operation.service";

export class WorkerQueueService {
	readonly serviceName = "WorkerQueueService";
	readonly logger = createLogger("WorkerQueueService");

	private onEnqueueCallback?: (() => void) | undefined;

	onEnqueue(callback: () => void): void {
		this.onEnqueueCallback = callback;
	}

	async enqueue(workerId: string, data: unknown, options: AddWorkerItemOptions = {}): Promise<WorkerItem> {
		const definition = getWorkerRuntime().registry.get(workerId);
		if (!definition) throw new DomainError("not_found", `Worker "${workerId}" is not registered`, { code: "worker.not_found" });

		const { result } = await enqueueWithOperation(
			{ type: workerId, reference: { type: "worker", id: workerId } },
			(operationId) =>
				workerDependencies().jobs.enqueue(this.buildWorkerItemInput(workerId, data, { ...options, operationId }, definition)),
			{
				operationId: options.operationId,
				// A dedupe hit returns the *existing* row with its own operation.
				isAttached: attachedToOperation,
			},
		);

		this.onEnqueueCallback?.();

		return result;
	}

	async enqueueMany(
		workerId: string,
		entries: Array<{ data: unknown; options?: AddWorkerItemOptions }>,
		enqueueOptions: { countOperationTotals?: boolean } = {},
	): Promise<WorkerItem[]> {
		if (entries.length === 0) return [];

		const definition = getWorkerRuntime().registry.get(workerId);
		if (!definition) throw new DomainError("not_found", `Worker "${workerId}" is not registered`, { code: "worker.not_found" });

		const buildInputs = (operationId?: string) =>
			entries.map(({ data, options = {} }) =>
				this.buildWorkerItemInput(workerId, data, { ...options, operationId: options.operationId ?? operationId }, definition),
			);

		let items: WorkerItem[];
		if (entries.some((entry) => !entry.options?.operationId)) {
			({ result: items } = await enqueueWithOperation(
				{ type: workerId, reference: { type: "worker", id: workerId } },
				(operationId) => workerDependencies().jobs.enqueueMany(buildInputs(operationId), enqueueOptions),
				// Every entry losing the dedupe race leaves the shared operation with no items.
				{ isAttached: anyAttachedToOperation },
			));
		} else {
			items = await workerDependencies().jobs.enqueueMany(buildInputs(), enqueueOptions);
		}

		this.onEnqueueCallback?.();

		return items;
	}

	findActive(workerId: string, dedupeKey: string): Promise<ActiveWorkerItem | undefined> {
		return workerDependencies().jobs.findActiveByDedupeKey(workerId, dedupeKey);
	}

	findActiveMany(workerId: string, dedupeKeys: readonly string[]): Promise<ActiveWorkerItem[]> {
		return workerDependencies().jobs.findActiveByWorkerAndDedupeKeys(workerId, dedupeKeys);
	}

	getJob(id: string): Promise<WorkerItem | undefined> {
		return workerDependencies().jobs.findItem(id);
	}

	listJobs(options: { limit: number; offset: number; workerId?: string | undefined; status?: WorkerItem["status"] | undefined }) {
		return workerDependencies().jobs.listItems(options);
	}

	async cancelJob(id: string): Promise<boolean> {
		const item = await workerDependencies().jobs.findItem(id);
		if (!item) return false;

		if (item.status === "pending") {
			const res = await workerDependencies().jobs.cancelPending(id);
			if (res) this.onEnqueueCallback?.();

			return res;
		}

		if (item.status === "running") {
			return await workerDependencies().jobs.cancelRunning(id);
		}

		return false;
	}

	async cancelAllPending(workerId?: string): Promise<number> {
		const count = await workerDependencies().jobs.cancelAllPending(workerId);
		if (count > 0) this.onEnqueueCallback?.();

		return count;
	}

	/** With `dryRun` nothing is deleted: the result counts the standalone jobs a purge would remove. */
	purgeHistory(options: TerminalPurgeRequest = {}): Promise<number> {
		const filter = terminalPurgeFilter(options);

		return options.dryRun ? workerDependencies().jobs.countTerminalJobs(filter) : workerDependencies().jobs.purgeTerminalJobs(filter);
	}

	private buildWorkerItemInput(
		workerId: string,
		data: unknown,
		options: AddWorkerItemOptions,
		definition: WorkerDefinition,
	): EnqueueWorkerItemInput {
		const backoff = options.backoff ?? definition.backoff ?? serverConfig.workers.scheduling.defaultBackoff;

		return {
			id: Bun.randomUUIDv7(),
			workerId,
			operationId: options.operationId,
			dependsOnJobId: options.dependsOnJobId ?? options.dependsOnTaskIds?.[0],
			dependsOnTaskIds: options.dependsOnTaskIds,
			data: JSON.stringify(data ?? null),
			dedupeKey: options.dedupeKey,
			referenceType: options.reference?.type,
			referenceId: options.reference?.id,
			priority: options.priority ?? definition.defaultPriority ?? 0,
			maxAttempts: Math.max(1, options.attempts ?? definition.attempts ?? serverConfig.workers.scheduling.defaultAttempts),
			backoffType: backoff.type,
			backoffDelayMs: Math.max(0, backoff.delayMs),
			runAt: new Date(Date.now() + Math.max(0, options.delayMs ?? 0)),
		};
	}
}
