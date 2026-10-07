import { v7 as uuidv7 } from "uuid";
import { type WorkerItem, workerJobRepository } from "@/database/repositories/worker.repository";
import {
	type WorkerOperationRecord,
	type WorkerOperationStatus,
	workerOperationRepository,
} from "@/database/repositories/worker-operation.repository";
import { QueryPagination } from "@/database/utils/pagination";
import { daysAgo } from "@/server.constants";
import { systemResourcesService } from "@/system/system-resources.service";
import { BaseService } from "@/utils/base-service";
import { ValidationError } from "@/utils/errors";
import { safeParseJson } from "@/utils/file.utils";
import { PromiseUtils } from "@/utils/promise.utils";
import { toJobContract, toOperationContract } from "../utils/worker-stats.mapper";
import type { WorkerOperationJobsQuery } from "../worker.types";
import { getWorkerRuntime } from "./worker-runtime";

/** Cancelled jobs re-read per page during resume — bounded memory for huge operations. */
const RESUME_PAGE_SIZE = 5000;

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
		const pagination = QueryPagination.resolvePageParams(options, { defaultLimit: 50 });
		const result = await workerOperationRepository.list({
			status: options.status,
			limit: pagination.limit,
			offset: pagination.offset,
		});

		return QueryPagination.createResponse({
			total: result.total,
			pagination,
			data: result.data.map(toOperationContract),
		});
	}

	async getOperationJobs(id: string, options: WorkerOperationJobsQuery = {}) {
		const pagination = QueryPagination.resolvePageParams(options, { defaultLimit: 50 });
		const [summary, { items, total }] = await Promise.all([
			workerOperationRepository.getOperationItemsSummary(id),
			workerOperationRepository.listItems(id, {
				status: options.status,
				search: options.search,
				limit: pagination.limit,
				offset: pagination.offset,
			}),
		]);

		return {
			items: items.map((item) => toJobContract(item, item.dependsOnJobId ? [item.dependsOnJobId] : [])),
			summary,
			...QueryPagination.buildAdminPagination({ total, page: pagination.page, limit: pagination.limit }),
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
	 * `markResumed` pre-sets the operation total to the full cancelled count so a
	 * page-by-page re-enqueue cannot terminalize the operation after its first
	 * chunk completes; the queue inserts then skip counter increments.
	 */
	async resume(id: string): Promise<{ resumed: number }> {
		const operation = await workerOperationRepository.findById(id);
		if (!operation) return { resumed: 0 };

		if (operation.status !== "cancelled") {
			throw new ValidationError(`Only cancelled operations can be resumed (status: ${operation.status})`);
		}

		const total = await workerJobRepository.countCancelledByOperation(id);
		if (total === 0) {
			throw new ValidationError("The operation has no cancelled tasks to resume");
		}

		// Clear the cancel request BEFORE re-enqueueing: `enqueueMany` validates the
		// operation and rejects any with `cancelRequested=true`.
		await workerOperationRepository.markResumed(id, total);

		let resumed = 0;
		let cursor: string | undefined;
		try {
			for (;;) {
				const items = await workerJobRepository.findCancelledByOperation(id, RESUME_PAGE_SIZE, cursor);
				if (items.length === 0) break;

				cursor = items.at(-1)?.id;
				const byWorker = new Map<string, WorkerItem[]>();
				for (const item of items) {
					const group = byWorker.get(item.workerId) ?? [];
					group.push(item);
					byWorker.set(item.workerId, group);
				}

				for (const [workerId, group] of byWorker) {
					const definition = getWorkerRuntime().registry.get(workerId);
					if (!definition) {
						this.logger.warn("Skipping resume group — worker is no longer registered", { workerId, operationId: id, items: group.length });
						continue;
					}

					await getWorkerRuntime().queue.enqueueMany(
						workerId,
						group.map((item) => ({
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
						// The operation total was pre-set above — per-insert increments
						// would double it and skew completion.
						{ countOperationTotals: false },
					);
					resumed += group.length;
				}

				if (items.length < RESUME_PAGE_SIZE) break;
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
