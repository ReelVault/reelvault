import type { WorkerJob as WorkerJobContract, WorkerOperation as WorkerOperationContract, WorkerQueueStats } from "@reelvault/sdk/common";
import { safeParseJson } from "@/utils/json.utils";
import { pickDefined } from "@/utils/type.utils";
import type { WorkerItemStats, WorkerItemSummary, WorkerOperation } from "@/workers/worker.ports";

export function toJobContract(item: WorkerItemSummary, dependsOnTaskIds: string[] = []): WorkerJobContract {
	return {
		id: item.id,
		workerId: item.workerId,
		dependsOnTaskIds: item.dependsOnJobId ? [item.dependsOnJobId] : dependsOnTaskIds,
		status: item.status,
		priority: item.priority,
		attempts: item.attempts,
		maxAttempts: item.maxAttempts,
		progressPercent: item.progressPercent,
		runAt: item.runAt.toISOString(),
		createdAt: item.createdAt.toISOString(),
		updatedAt: item.updatedAt.toISOString(),
		...pickDefined({
			operationId: item.operationId,
			dedupeKey: item.dedupeKey,
			referenceType: item.referenceType,
			referenceId: item.referenceId,
			runnerId: item.runnerId,
			result: item.result ? safeParseJson(item.result) : undefined,
			error: item.error,
			startedAt: item.startedAt?.toISOString(),
			completedAt: item.completedAt?.toISOString(),
		}),
	};
}

export function applyStats(stats: WorkerQueueStats, row: WorkerItemStats): void {
	switch (row.status) {
		case "pending":
			stats.waiting = row.count;
			break;
		case "running":
			stats.active = row.count;
			break;
		case "completed":
			stats.completed = row.count;
			break;
		case "failed":
			stats.failed = row.count;
			break;
		case "cancelled":
			break;
		default:
			break;
	}
}

export function toOperationContract(operation: WorkerOperation): WorkerOperationContract {
	return {
		id: operation.id,
		type: operation.type,
		status: operation.status,
		cancelRequested: operation.cancelRequested,
		totalItems: operation.totalItems,
		pendingItems: operation.pendingItems,
		runningItems: operation.runningItems,
		completedItems: operation.completedItems,
		failedItems: operation.failedItems,
		cancelledItems: operation.cancelledItems,
		progressPercent: operation.progressPercent,
		etaMs: operation.etaMs,
		createdAt: operation.createdAt.toISOString(),
		updatedAt: operation.updatedAt.toISOString(),
		...pickDefined({
			referenceType: operation.referenceType,
			referenceId: operation.referenceId,
			error: operation.error,
			startedAt: operation.startedAt?.toISOString(),
			completedAt: operation.completedAt?.toISOString(),
		}),
	};
}
