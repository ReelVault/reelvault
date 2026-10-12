import type { TaskTrigger, WorkerCategory, WorkerCategoryRunResponse, WorkerSummary } from "@reelvault/sdk/common";
import { recordAuditSafe } from "@/application/admin/admin-audit.service";
import type { AdminAuditContext } from "@/database/repositories/admin-audit.repository";
import { QueryPagination } from "@/database/utils/pagination";
import { assertFound, DomainError } from "@/utils/errors";
import { createLogger } from "@/utils/logger";
import { workerService } from "../../workers/worker.service";

class AdminWorkerOperationsService {
	readonly serviceName = "AdminWorkerOperationsService";
	readonly logger = createLogger("AdminWorkerOperationsService");

	getWorkerSummaries(): Promise<WorkerSummary[]> {
		return workerService.scheduler.listWorkerSummaries();
	}

	getWatchdogState() {
		return workerService.watchdog.getState();
	}

	async runWorker(workerId: string, data?: unknown, context?: AdminAuditContext) {
		const result = await workerService.scheduler.runWorkerManually(workerId, data);
		recordAuditSafe(
			{
				action: "create",
				resourceType: "worker_run",
				resourceId: workerId,
				after: { workerId, ...result },
				context,
			},
			this.logger,
		);

		return result;
	}

	async runWorkerCategory(category: WorkerCategory, context?: AdminAuditContext): Promise<WorkerCategoryRunResponse> {
		const result = await workerService.scheduler.runWorkerCategoryManually(category);
		recordAuditSafe(
			{
				action: "create",
				resourceType: "worker_category_run",
				resourceId: category,
				after: { category, started: result.started.map((s) => s.workerId), skipped: result.skipped },
				context,
			},
			this.logger,
		);

		return result;
	}

	async updateWorkerTriggers(workerId: string, triggers: TaskTrigger[], context?: AdminAuditContext) {
		const result = await workerService.scheduler.updateWorkerTriggers(workerId, triggers);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_triggers",
				resourceId: workerId,
				after: { workerId, triggers },
				context,
			},
			this.logger,
		);

		return result;
	}

	async setScheduleEnabled(workerId: string, enabled: boolean, context?: AdminAuditContext) {
		const result = await workerService.scheduler.setScheduleEnabled(workerId, enabled);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_schedule",
				resourceId: workerId,
				summary: enabled ? "Scheduled runs resumed" : "Scheduled runs paused",
				after: result,
				context,
			},
			this.logger,
		);

		return result;
	}

	async getItems(
		query: {
			page?: number | undefined;
			limit?: number | undefined;
			workerId?: string | undefined;
			status?: "pending" | "running" | "completed" | "failed" | "cancelled" | undefined;
		} = {},
	) {
		const pagination = QueryPagination.resolvePageParams(query, { defaultLimit: 50 });
		const result = await workerService.listItems({
			workerId: query.workerId,
			status: query.status,
			limit: pagination.limit,
			offset: pagination.offset,
		});

		return QueryPagination.createResponse({ total: result.total, pagination, data: result.items });
	}

	async getItem(id: string) {
		const item = await workerService.getItem(id);
		assertFound(item, "Worker item", id);

		return item;
	}

	getStats() {
		return workerService.getStats();
	}

	async getOperation(id: string) {
		const operation = await workerService.getOperation(id);
		assertFound(operation, "Worker operation", id);

		return operation;
	}

	getOperations(query?: {
		status?: "pending" | "running" | "completed" | "failed" | "cancelled" | "active" | undefined;
		page?: number | undefined;
		limit?: number | undefined;
	}) {
		return workerService.listOperations(query);
	}

	async getOperationItems(
		id: string,
		query?: {
			status?: "pending" | "running" | "completed" | "failed" | "cancelled" | undefined;
			search?: string | undefined;
			page?: number | undefined;
			limit?: number | undefined;
		},
	) {
		await this.getOperation(id);

		return workerService.getOperationItems(id, query);
	}

	async cancelOperation(id: string, context?: AdminAuditContext): Promise<{ success: true }> {
		const operation = await workerService.getOperation(id);
		assertFound(operation, "Worker operation", id);

		const cancelled = await workerService.cancelOperation(id);
		if (!cancelled) {
			throw new DomainError("conflict", "The worker operation could not be cancelled", {
				code: "worker.operation_cancel_failed",
				params: { operationId: id },
			});
		}

		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_operation",
				resourceId: id,
				before: operation,
				after: { ...operation, status: "cancelled" },
				context,
			},
			this.logger,
		);

		return { success: true };
	}

	async resumeOperation(id: string, context?: AdminAuditContext): Promise<{ success: true; resumed: number }> {
		const operation = await workerService.getOperation(id);
		assertFound(operation, "Worker operation", id);

		const result = await workerService.resumeOperation(id);

		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_operation",
				resourceId: id,
				before: operation,
				after: { ...operation, status: "pending", resumedTasks: result.resumed },
				context,
			},
			this.logger,
		);

		return { success: true, resumed: result.resumed };
	}

	async cancelAllOperations(context?: AdminAuditContext): Promise<{ count: number }> {
		const count = await workerService.cancelAllOperations();
		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_operation_batch",
				resourceId: "all_active",
				after: { cancelledCount: count },
				context,
			},
			this.logger,
		);

		return { count };
	}

	async cancelItem(id: string, context?: AdminAuditContext): Promise<{ success: true }> {
		const item = await workerService.getItem(id);
		assertFound(item, "Worker item", id);
		if (item.status !== "pending" && item.status !== "running") {
			throw new DomainError("conflict", "Only pending or running worker items can be cancelled", {
				code: "worker.item_not_cancellable",
				params: { itemId: id, status: item.status },
			});
		}

		const cancelled = await workerService.cancelItem(id);
		if (!cancelled) {
			throw new DomainError("conflict", "The worker item could not be cancelled", {
				code: "worker.item_cancel_failed",
				params: { itemId: id },
			});
		}

		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_item",
				resourceId: id,
				before: item,
				after: { ...item, status: "cancelled" },
				context,
			},
			this.logger,
		);

		return { success: true };
	}

	async retryItem(id: string, context?: AdminAuditContext): Promise<{ success: true; jobId: string }> {
		const item = await workerService.getItem(id);
		assertFound(item, "Worker item", id);
		if (item.status !== "failed") {
			throw new DomainError("conflict", "Only failed worker items can be retried", {
				code: "worker.item_not_retryable",
				params: { itemId: id, status: item.status },
			});
		}

		const retried = await workerService.retryItem(id);
		assertFound(retried, "Worker item", id);

		recordAuditSafe(
			{
				action: "create",
				resourceType: "worker_item",
				resourceId: retried.id,
				summary: `Retried failed worker item ${id}`,
				before: item,
				after: retried,
				context,
			},
			this.logger,
		);

		return { success: true, jobId: retried.id };
	}

	async cancelPendingItems(workerId?: string, context?: AdminAuditContext): Promise<{ count: number }> {
		const count = await workerService.cancelAllPending(workerId);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_queue",
				resourceId: workerId ?? "all",
				after: { workerId: workerId ?? "all", cancelledCount: count },
				context,
			},
			this.logger,
		);

		return { count };
	}

	async purgeHistory(
		options: {
			status?: "completed" | "failed" | "cancelled" | "all_terminal" | undefined;
			olderThanDays?: number | undefined;
			dryRun?: boolean | undefined;
		} = {},
		context?: AdminAuditContext,
	): Promise<{ success: true; dryRun: boolean; deletedJobsCount: number; deletedOperationsCount: number }> {
		const result = await workerService.purgeHistory(options);

		// A dry run removes nothing, so there is no change to record.
		if (!options.dryRun) {
			recordAuditSafe(
				{
					action: "delete",
					resourceType: "worker_history",
					resourceId: options.status ?? "all_terminal",
					after: { ...options, ...result },
					context,
				},
				this.logger,
			);
		}

		return {
			success: true,
			dryRun: options.dryRun === true,
			deletedJobsCount: result.deletedJobsCount,
			deletedOperationsCount: result.deletedOperationsCount,
		};
	}
}

export const adminWorkerOperationsService = new AdminWorkerOperationsService();
