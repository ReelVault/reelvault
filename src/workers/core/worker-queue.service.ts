import type { AddWorkerItemOptions, WorkerDefinition } from "@reelvault/sdk/common";
import { v7 as uuidv7 } from "uuid";
import {
	type ActiveWorkerItem,
	type EnqueueWorkerItemInput,
	type WorkerItem,
	type WorkerItemSummary,
	workerJobRepository,
} from "@/database/repositories/worker.repository";
import { serverConfig } from "@/server.config";
import { daysAgo } from "@/server.constants";
import { BaseService } from "@/utils/base-service";
import { NotFoundError } from "@/utils/errors";
import { enqueueWithOperation } from "./worker-operation-enqueue";
import { getWorkerRuntime } from "./worker-runtime";

export class WorkerQueueService extends BaseService {
	private onEnqueueCallback?: (() => void) | undefined;

	constructor() {
		super("WorkerQueueService");
	}

	onEnqueue(callback: () => void): void {
		this.onEnqueueCallback = callback;
	}

	async enqueue(workerId: string, data: unknown, options: AddWorkerItemOptions = {}): Promise<WorkerItem> {
		const definition = getWorkerRuntime().registry.get(workerId);
		if (!definition) throw new NotFoundError(`Worker "${workerId}" is not registered`);

		const { result } = await enqueueWithOperation(
			{ type: workerId, reference: { type: "worker", id: workerId } },
			(operationId) => workerJobRepository.enqueue(this.buildWorkerItemInput(workerId, data, { ...options, operationId }, definition)),
			{
				operationId: options.operationId,
				// A dedupe hit returns the *existing* row with its own operation.
				isAttached: (item, operationId) => item.operationId === operationId,
			},
		);

		this.onEnqueueCallback?.();

		return result;
	}

	async enqueueMany(workerId: string, entries: Array<{ data: unknown; options?: AddWorkerItemOptions }>): Promise<WorkerItem[]> {
		if (entries.length === 0) return [];

		const definition = getWorkerRuntime().registry.get(workerId);
		if (!definition) throw new NotFoundError(`Worker "${workerId}" is not registered`);

		const buildInputs = (operationId?: string) =>
			entries.map(({ data, options = {} }) =>
				this.buildWorkerItemInput(workerId, data, { ...options, operationId: options.operationId ?? operationId }, definition),
			);

		let items: WorkerItem[];
		if (entries.some((entry) => !entry.options?.operationId)) {
			({ result: items } = await enqueueWithOperation(
				{ type: workerId, reference: { type: "worker", id: workerId } },
				(operationId) => workerJobRepository.enqueueMany(buildInputs(operationId)),
				// Every entry losing the dedupe race leaves the shared operation with no items.
				{ isAttached: (batch, operationId) => batch.some((item) => item.operationId === operationId) },
			));
		} else {
			items = await workerJobRepository.enqueueMany(buildInputs());
		}

		this.onEnqueueCallback?.();

		return items;
	}

	findActive(workerId: string, dedupeKey: string): Promise<ActiveWorkerItem | undefined> {
		return workerJobRepository.findActiveByDedupeKey(workerId, dedupeKey);
	}

	findActiveMany(workerId: string, dedupeKeys: readonly string[]): Promise<ActiveWorkerItem[]> {
		return workerJobRepository.findActiveByWorkerAndDedupeKeys(workerId, dedupeKeys);
	}

	getJob(id: string): Promise<WorkerItem | undefined> {
		return workerJobRepository.findItem(id);
	}

	listJobs(limit = 100, workerId?: string, status?: WorkerItem["status"]): Promise<WorkerItemSummary[]> {
		return workerJobRepository.listItems(limit, workerId, status);
	}

	async cancelJob(id: string): Promise<boolean> {
		const item = await workerJobRepository.findItem(id);
		if (!item) return false;

		if (item.status === "pending") {
			const res = await workerJobRepository.cancelPending(id);
			if (res) this.onEnqueueCallback?.();

			return res;
		}

		if (item.status === "running") {
			return await workerJobRepository.cancelRunning(id);
		}

		return false;
	}

	async cancelAllPending(workerId?: string): Promise<number> {
		const count = await workerJobRepository.cancelAllPending(workerId);
		if (count > 0) this.onEnqueueCallback?.();

		return count;
	}

	purgeHistory(
		options: { status?: "completed" | "failed" | "cancelled" | "all_terminal" | undefined; olderThanDays?: number | undefined } = {},
	): Promise<number> {
		const cutoffDate = options.olderThanDays && options.olderThanDays > 0 ? daysAgo(options.olderThanDays) : undefined;

		return workerJobRepository.purgeTerminalJobs({
			status: options.status,
			cutoffDate,
		});
	}

	private buildWorkerItemInput(
		workerId: string,
		data: unknown,
		options: AddWorkerItemOptions,
		definition: WorkerDefinition,
	): EnqueueWorkerItemInput {
		const backoff = options.backoff ?? definition.backoff ?? serverConfig.workers.scheduling.defaultBackoff;

		return {
			id: uuidv7(),
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
