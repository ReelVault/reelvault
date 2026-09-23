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
import { workerOperationsService } from "./worker-operations.service";
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

		let operationId = options.operationId;
		let createdOperation = false;
		if (!operationId) {
			const op = await workerOperationsService.create({
				type: workerId,
				reference: { type: "worker", id: workerId },
			});
			operationId = op.id;
			createdOperation = true;
		}

		const item = this.buildWorkerItemInput(workerId, data, { ...options, operationId }, definition);
		try {
			const result = await workerJobRepository.enqueue(item);
			// A dedupe hit returns the *existing* row with its own operation — the
			// freshly created operation would otherwise stay `pending` forever with 0 items.
			if (createdOperation && result.operationId !== operationId) {
				await workerOperationsService.remove(operationId).catch(() => {
					// intentionally empty
				});
			}

			this.onEnqueueCallback?.();

			return result;
		} catch (error) {
			if (createdOperation) {
				// Best-effort cleanup — ignore failures
				await workerOperationsService.remove(operationId).catch(() => {
					// intentionally empty
				});
			}

			throw error;
		}
	}

	async enqueueMany(workerId: string, entries: Array<{ data: unknown; options?: AddWorkerItemOptions }>): Promise<WorkerItem[]> {
		if (entries.length === 0) return [];

		const definition = getWorkerRuntime().registry.get(workerId);
		if (!definition) throw new NotFoundError(`Worker "${workerId}" is not registered`);

		let sharedOperationId: string | undefined;
		let createdOperation = false;
		if (entries.some((e) => !e.options?.operationId)) {
			const op = await workerOperationsService.create({
				type: workerId,
				reference: { type: "worker", id: workerId },
			});
			sharedOperationId = op.id;
			createdOperation = true;
		}

		const opId = sharedOperationId;
		const inputs = entries.map(({ data, options = {} }) =>
			this.buildWorkerItemInput(workerId, data, { ...options, operationId: options.operationId ?? opId }, definition),
		);

		try {
			const items = await workerJobRepository.enqueueMany(inputs);
			// Every entry lost the dedupe race — the shared operation has no items.
			if (createdOperation && opId && !items.some((item) => item.operationId === opId)) {
				await workerOperationsService.remove(opId).catch(() => {
					// intentionally empty
				});
			}

			this.onEnqueueCallback?.();

			return items;
		} catch (error) {
			if (createdOperation && opId) {
				// Best-effort cleanup — ignore failures
				await workerOperationsService.remove(opId).catch(() => {
					// intentionally empty
				});
			}

			throw error;
		}
	}

	findActive(workerId: string, dedupeKey: string): Promise<ActiveWorkerItem | undefined> {
		return workerJobRepository.findActiveByWorkerAndDedupe(workerId, dedupeKey);
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
