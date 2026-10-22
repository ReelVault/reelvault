import { systemResourcesService } from "@/config/system-resources.service";
import { buildAdminPagination, createPageResponse, resolvePageParams } from "@/integrations/drizzle-orm/query/pagination.utils";
import { workerJobRepository } from "@/repositories/worker.repository";
import type { WorkerItem } from "@/repositories/worker-jobs/shared.types";
import type { WorkerOperationRecord, WorkerOperationStatus } from "@/repositories/worker-operation/shared.types";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { DomainError } from "@/utils/domain.errors";
import { safeParseJson } from "@/utils/json.utils";
import { createLogger } from "@/utils/logger.utils";
import { mapConcurrent } from "@/utils/promise.utils";
import { type TerminalPurgeRequest, terminalPurgeFilter } from "@/workers/utils/worker-purge.utils";
import { toJobContract, toOperationContract } from "@/workers/utils/worker-stats.mapper";
import type { WorkerOperationJobsQuery } from "@/workers/worker.types";
import { getWorkerRuntime } from "./worker.runtime";

/** Cancelled jobs re-read per page during resume — bounded memory for huge operations. */
const RESUME_PAGE_SIZE = 5000;

export const workerOperationsService = {
	serviceName: "WorkerOperationsService",
	logger: createLogger("WorkerOperationsService"),

	create(input: { type: string; reference?: { type: string; id: string }; error?: string }): Promise<WorkerOperationRecord> {
		return workerOperationRepository.create({
			id: Bun.randomUUIDv7(),
			type: input.type,
			referenceType: input.reference?.type,
			referenceId: input.reference?.id,
			error: input.error,
		});
	},

	async getById(id: string) {
		const operation = await workerOperationRepository.findById(id);

		return operation ? toOperationContract(operation) : undefined;
	},

	async list(
		options: { status?: WorkerOperationStatus | "active" | undefined; page?: number | undefined; limit?: number | undefined } = {},
	) {
		const pagination = resolvePageParams(options, { defaultLimit: 50 });
		const result = await workerOperationRepository.list({
			status: options.status,
			limit: pagination.limit,
			offset: pagination.offset,
		});

		return createPageResponse({
			total: result.total,
			pagination,
			data: result.data.map(toOperationContract),
		});
	},

	async getOperationJobs(id: string, options: WorkerOperationJobsQuery = {}) {
		const pagination = resolvePageParams(options, { defaultLimit: 50 });
		const [summary, { items, total }] = await Promise.all([
			workerOperationRepository.getOperationItemsSummary(id),
			workerOperationRepository.listItems(id, {
				status: options.status,
				search: options.q,
				limit: pagination.limit,
				offset: pagination.offset,
			}),
		]);

		return {
			data: items.map((item) => toJobContract(item, item.dependsOnJobId ? [item.dependsOnJobId] : [])),
			summary,
			...buildAdminPagination({ total, page: pagination.page, limit: pagination.limit }),
		};
	},

	async cancel(id: string): Promise<boolean> {
		const operation = await workerOperationRepository.findById(id);
		if (!operation || (operation.status !== "pending" && operation.status !== "running")) return false;

		await workerOperationRepository.requestCancel(id);
		// Pending rows first: the poller claims them without consulting the cancel
		// request, so the window between the two calls must be as short as possible.
		await workerJobRepository.cancelPendingByOperation(id);

		const runningItems = await workerJobRepository.findRunningByOperation(id);
		for (const item of runningItems) {
			getWorkerRuntime().pool.cancel(item.id);
		}

		if (runningItems.length > 0) {
			await mapConcurrent(runningItems, systemResourcesService.getIoConcurrency(), async (item) =>
				workerJobRepository.cancelRunning(item.id),
			);
		}

		return true;
	},

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
			throw new DomainError("validation", `Only cancelled operations can be resumed (status: ${operation.status})`, {
				code: "worker.operation_not_cancelled",
			});
		}

		const total = await workerJobRepository.countCancelledByOperation(id);
		if (total === 0) {
			throw new DomainError("validation", "The operation has no cancelled tasks to resume", { code: "worker.nothing_to_resume" });
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
						workerOperationsService.logger.warn("Skipping resume group — worker is no longer registered", {
							workerId,
							operationId: id,
							items: group.length,
						});
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
			// Re-enqueue failed part-way: cancel what was inserted and rebuild the
			// counters from the surviving rows, so the operation cannot sit pending
			// with a total nothing will ever reach.
			await workerJobRepository.cancelPendingByOperation(id).catch(() => {
				// best-effort rollback
			});
			await workerOperationRepository.reconcileFromJobs(id).catch(() => {
				// best-effort rollback
			});
			throw error;
		}

		// The pre-set total counted every cancelled row; rows skipped because the
		// worker is gone or the dedupe key is active never become jobs. Rebuild the
		// counters from the inserted rows so the operation can terminalize.
		await workerOperationRepository.reconcileFromJobs(id);

		return { resumed };
	},

	async cancelAll(): Promise<number> {
		const concurrency = systemResourcesService.getIngestConcurrency();
		let cancelled = 0;
		// `requestCancel` moves an operation out of the "active" set immediately,
		// so re-list from the top each pass instead of paginating (offset paging
		// would skip rows as the result set shrinks). The old code only ever saw
		// the first 1000 active operations.
		let activeOperations = await workerOperationRepository.list({ status: "active", limit: 1000 });
		while (activeOperations.data.length > 0) {
			const results = await mapConcurrent(activeOperations.data, concurrency, async (op) => workerOperationsService.cancel(op.id));
			const batchCancelled = results.filter((wasCancelled) => wasCancelled).length;
			// No progress means the remaining rows cannot be cancelled — stop rather than spin.
			if (batchCancelled === 0) break;

			cancelled += batchCancelled;
			activeOperations = await workerOperationRepository.list({ status: "active", limit: 1000 });
		}

		return cancelled;
	},

	/** With `dryRun` nothing is deleted: the result counts the operations and jobs a purge would remove. */
	purgeHistory(options: TerminalPurgeRequest = {}): Promise<{ deletedOperationsCount: number; deletedJobsCount: number }> {
		const filter = terminalPurgeFilter(options);

		return options.dryRun
			? workerOperationRepository.countTerminalOperations(filter)
			: workerOperationRepository.purgeTerminalOperations(filter);
	},

	cleanupExpired(): Promise<number> {
		return workerOperationRepository.cleanupExpired();
	},

	async remove(id: string): Promise<void> {
		await workerOperationRepository.remove(id);
	},
};

/** The singleton's shape, for callers that inject or declare the operations surface. */
export type WorkerOperationsService = typeof workerOperationsService;
