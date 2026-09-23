import { v7 as uuidv7 } from "uuid";
import { type WorkerItem, workerJobRepository } from "@/database/repositories/worker.repository";
import {
	type WorkerOperationRecord,
	type WorkerOperationStatus,
	workerOperationRepository,
} from "@/database/repositories/worker-operation.repository";
import { daysAgo } from "@/server.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { ValidationError } from "@/utils/errors";
import { safeParseJson } from "@/utils/file.utils";
import { clamp } from "@/utils/math.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { toJobContract, toOperationContract } from "../utils/worker-stats.mapper";
import { getWorkerRuntime } from "./worker-runtime";

export class WorkerOperationsService extends BaseService {
	constructor() {
		super("WorkerOperationsService");
	}

	create(input: { type: string; reference?: { type: string; id: string }; error?: string }): Promise<WorkerOperationRecord> {
		return workerOperationRepository.create({
			id: uuidv7(),
			type: input.type,
			referenceType: input.reference?.type,
			referenceId: input.reference?.id,
			error: input.error,
		});
	}

	async getById(id: string) {
		const operation = await workerOperationRepository.findById(id);

		return operation ? toOperationContract(operation) : undefined;
	}

	async list(
		options: { status?: WorkerOperationStatus | "active" | undefined; page?: number | undefined; limit?: number | undefined } = {},
	) {
		const page = clamp(options.page ?? 1, 1, 1000);
		const limit = clamp(options.limit ?? 50, 1, 100);
		const result = await workerOperationRepository.list({
			status: options.status,
			limit,
			offset: (page - 1) * limit,
		});

		return {
			page,
			limit,
			total: result.total,
			totalPages: result.total > 0 ? Math.ceil(result.total / limit) : 0,
			data: result.data.map(toOperationContract),
		};
	}

	async getOperationJobs(
		id: string,
		options: {
			status?: "pending" | "running" | "completed" | "failed" | "cancelled" | undefined;
			search?: string | undefined;
			page?: number | undefined;
			limit?: number | undefined;
		} = {},
	) {
		const page = clamp(options.page ?? 1, 1, 1000);
		const limit = clamp(options.limit ?? 50, 1, 100);
		const offset = (page - 1) * limit;

		const [summary, { items, total }] = await Promise.all([
			workerOperationRepository.getOperationItemsSummary(id),
			workerOperationRepository.listItems(id, {
				status: options.status,
				search: options.search,
				limit,
				offset,
			}),
		]);

		return {
			items: items.map((item) => toJobContract(item, item.dependsOnJobId ? [item.dependsOnJobId] : [])),
			summary,
			page,
			limit,
			total,
			totalPages: total > 0 ? Math.ceil(total / limit) : 0,
		};
	}

	async cancel(id: string): Promise<boolean> {
		const operation = await workerOperationRepository.findById(id);
		if (!operation || (operation.status !== "pending" && operation.status !== "running")) return false;

		await workerOperationRepository.requestCancel(id);

		const runningItems = await workerJobRepository.findRunningByOperation(id);
		for (const item of runningItems) {
			getWorkerRuntime().pool.cancel(item.id);
		}

		if (runningItems.length > 0) {
			await PromiseUtils.mapConcurrent(runningItems, systemResourcesService.getIoConcurrency(), async (item) =>
				workerJobRepository.cancelRunning(item.id),
			);
		}

		await workerJobRepository.cancelPendingByOperation(id);

		return true;
	}

	/**
	 * Re-enqueues the cancelled jobs of a stopped operation (admin "resume").
	 * The queue's insert path increments the operation counters, and
	 * markResumed clears the cancel request so progress tracking resumes.
	 */
	async resume(id: string): Promise<{ resumed: number }> {
		const operation = await workerOperationRepository.findById(id);
		if (!operation) return { resumed: 0 };

		if (operation.status !== "cancelled") {
			throw new ValidationError(`Only cancelled operations can be resumed (status: ${operation.status})`);
		}

		const cancelledItems = await workerJobRepository.findCancelledByOperation(id);
		if (cancelledItems.length === 0) {
			throw new ValidationError("The operation has no cancelled tasks to resume");
		}

		const byWorker = new Map<string, WorkerItem[]>();
		for (const item of cancelledItems) {
			const group = byWorker.get(item.workerId) ?? [];
			group.push(item);
			byWorker.set(item.workerId, group);
		}

		let resumed = 0;
		// Clear the cancel request BEFORE re-enqueueing: `enqueueMany` validates the
		// operation and rejects any with `cancelRequested=true`, so resuming after
		// `markResumed` (the old order) always threw a 409 and never re-enqueued.
		await workerOperationRepository.markResumed(id);
		try {
			for (const [workerId, items] of byWorker) {
				const definition = getWorkerRuntime().registry.get(workerId);
				if (!definition) {
					this.logger.warn("Skipping resume group — worker is no longer registered", { workerId, operationId: id, items: items.length });
					continue;
				}

				await getWorkerRuntime().queue.enqueueMany(
					workerId,
					items.map((item) => ({
						data: safeParseJson(item.data) ?? item.data,
						options: {
							operationId: id,
							// Preserve scheduling metadata; attempts reset to a fresh budget.
							priority: item.priority,
							attempts: item.maxAttempts,
							backoff: { type: item.backoffType, delayMs: item.backoffDelayMs },
							...(item.dedupeKey ? { dedupeKey: item.dedupeKey } : {}),
							...(item.referenceType && item.referenceId ? { reference: { type: item.referenceType, id: item.referenceId } } : {}),
						},
					})),
				);
				resumed += items.length;
			}
		} catch (error) {
			// Re-enqueue failed part-way — put the operation back into the cancelled
			// state so it does not sit "pending" with no queued work.
			await workerOperationRepository.requestCancel(id).catch(() => {
				// best-effort rollback
			});
			throw error;
		}

		return { resumed };
	}

	async cancelAll(): Promise<number> {
		const concurrency = systemResourcesService.getIngestConcurrency();
		let cancelled = 0;
		// `requestCancel` moves an operation out of the "active" set immediately,
		// so re-list from the top each pass instead of paginating (offset paging
		// would skip rows as the result set shrinks). The old code only ever saw
		// the first 1000 active operations.
		let activeOperations = await workerOperationRepository.list({ status: "active", limit: 1000 });
		while (activeOperations.data.length > 0) {
			const results = await PromiseUtils.mapConcurrent(activeOperations.data, concurrency, async (op) => this.cancel(op.id));
			const batchCancelled = results.filter((wasCancelled) => wasCancelled).length;
			// No progress means the remaining rows cannot be cancelled — stop rather than spin.
			if (batchCancelled === 0) break;

			cancelled += batchCancelled;
			activeOperations = await workerOperationRepository.list({ status: "active", limit: 1000 });
		}

		return cancelled;
	}

	purgeHistory(
		options: { status?: "completed" | "failed" | "cancelled" | "all_terminal" | undefined; olderThanDays?: number | undefined } = {},
	): Promise<{ deletedOperationsCount: number; deletedJobsCount: number }> {
		const cutoffDate = options.olderThanDays && options.olderThanDays > 0 ? daysAgo(options.olderThanDays) : undefined;

		return workerOperationRepository.purgeTerminalOperations({
			status: options.status,
			cutoffDate,
		});
	}

	cleanupExpired(): Promise<number> {
		return workerOperationRepository.cleanupExpired();
	}

	async remove(id: string): Promise<void> {
		await workerOperationRepository.remove(id);
	}
}

export const workerOperationsService = new WorkerOperationsService();
