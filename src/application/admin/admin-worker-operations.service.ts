import type { TaskTrigger, WorkerCategory, WorkerCategoryRunResponse, WorkerSummary } from "@reelvault/sdk/common";
import { recordAuditSafe } from "@/application/admin/admin-audit.service";
import { BaseService } from "@/utils/base-service";
import { ConflictError } from "@/utils/errors";
import { workerService } from "../../workers/worker.service";

class AdminWorkerOperationsService extends BaseService {
	constructor() {
		super("AdminWorkerOperationsService");
	}

	getWorkerSummaries(): Promise<WorkerSummary[]> {
		return workerService.scheduler.listWorkerSummaries();
	}

	async runWorker(workerId: string, data?: unknown, actorUserId?: string, headers?: Headers) {
		const result = await workerService.scheduler.runWorkerManually(workerId, data);
		recordAuditSafe(
			{
				action: "create",
				resourceType: "worker_run",
				resourceId: workerId,
				after: { workerId, ...result },
				context: { actorUserId, headers },
			},
			this.logger,
		);

		return result;
	}

	async runWorkerCategory(category: WorkerCategory, actorUserId?: string, headers?: Headers): Promise<WorkerCategoryRunResponse> {
		const result = await workerService.scheduler.runWorkerCategoryManually(category);
		recordAuditSafe(
			{
				action: "create",
				resourceType: "worker_category_run",
				resourceId: category,
				after: { category, started: result.started.map((s) => s.workerId), skipped: result.skipped },
				context: { actorUserId, headers },
			},
			this.logger,
		);

		return result;
	}

	async updateWorkerTriggers(workerId: string, triggers: TaskTrigger[], actorUserId?: string, headers?: Headers) {
		const result = await workerService.scheduler.updateWorkerTriggers(workerId, triggers);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_triggers",
				resourceId: workerId,
				after: { workerId, triggers },
				context: { actorUserId, headers },
			},
			this.logger,
		);

		return result;
	}

	getItems(limit?: number, workerId?: string) {
		return workerService.listItems(limit, workerId);
	}

	async getItem(id: string) {
		const item = await workerService.getItem(id);
		this.assertExists(item, "Worker item", id);

		return item;
	}

	getStats() {
		return workerService.getStats();
	}

	async getOperation(id: string) {
		const operation = await workerService.getOperation(id);
		this.assertExists(operation, "Worker operation", id);

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

	async cancelOperation(id: string, actorUserId?: string, headers?: Headers): Promise<{ success: true }> {
		const operation = await workerService.getOperation(id);
		this.assertExists(operation, "Worker operation", id);

		const cancelled = await workerService.cancelOperation(id);
		if (!cancelled) throw new ConflictError("The worker operation could not be cancelled");

		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_operation",
				resourceId: id,
				before: operation,
				after: { ...operation, status: "cancelled" },
				context: { actorUserId, headers },
			},
			this.logger,
		);

		return { success: true };
	}

	async resumeOperation(id: string, actorUserId?: string, headers?: Headers): Promise<{ success: true; resumed: number }> {
		const operation = await workerService.getOperation(id);
		this.assertExists(operation, "Worker operation", id);

		const result = await workerService.resumeOperation(id);

		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_operation",
				resourceId: id,
				before: operation,
				after: { ...operation, status: "pending", resumedTasks: result.resumed },
				context: { actorUserId, headers },
			},
			this.logger,
		);

		return { success: true, resumed: result.resumed };
	}

	async cancelAllOperations(actorUserId?: string, headers?: Headers): Promise<{ count: number }> {
		const count = await workerService.cancelAllOperations();
		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_operation_batch",
				resourceId: "all_active",
				after: { cancelledCount: count },
				context: { actorUserId, headers },
			},
			this.logger,
		);

		return { count };
	}

	async cancelItem(id: string, actorUserId?: string, headers?: Headers): Promise<{ success: true }> {
		const item = await workerService.getItem(id);
		this.assertExists(item, "Worker item", id);
		if (item.status !== "pending" && item.status !== "running") {
			throw new ConflictError("Only pending or running worker items can be cancelled");
		}

		const cancelled = await workerService.cancelItem(id);
		if (!cancelled) throw new ConflictError("The worker item could not be cancelled");

		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_item",
				resourceId: id,
				before: item,
				after: { ...item, status: "cancelled" },
				context: { actorUserId, headers },
			},
			this.logger,
		);

		return { success: true };
	}

	async cancelPendingItems(workerId?: string, actorUserId?: string, headers?: Headers): Promise<{ count: number }> {
		const count = await workerService.cancelAllPending(workerId);
		recordAuditSafe(
			{
				action: "update",
				resourceType: "worker_queue",
				resourceId: workerId ?? "all",
				after: { workerId: workerId ?? "all", cancelledCount: count },
				context: { actorUserId, headers },
			},
			this.logger,
		);

		return { count };
	}

	async purgeHistory(
		options: {
			status?: "completed" | "failed" | "cancelled" | "all_terminal" | undefined;
			olderThanDays?: number | undefined;
		} = {},
		actorUserId?: string,
		headers?: Headers,
	): Promise<{ success: true; deletedJobsCount: number; deletedOperationsCount: number }> {
		const result = await workerService.purgeHistory(options);

		recordAuditSafe(
			{
				action: "delete",
				resourceType: "worker_history",
				resourceId: options.status ?? "all_terminal",
				after: { ...options, ...result },
				context: { actorUserId, headers },
			},
			this.logger,
		);

		return {
			success: true,
			deletedJobsCount: result.deletedJobsCount,
			deletedOperationsCount: result.deletedOperationsCount,
		};
	}
}

export const adminWorkerOperationsService = new AdminWorkerOperationsService();
