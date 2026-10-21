import {
	PaginatedResponseSchema,
	PurgeWorkerHistoryOptionsSchema,
	PurgeWorkerHistoryResponseSchema,
	SuccessResponseSchema,
	TaskTriggerSchema,
	UpdateTaskTriggersRequestSchema,
	WorkerCategoryRunResponseSchema,
	WorkerCategorySchema,
	WorkerJobSchema,
	WorkerJobStateSchema,
	WorkerOperationJobsResponseSchema,
	WorkerOperationSchema,
	WorkerRetryResponseSchema,
	WorkerScheduleEnabledRequestSchema,
	WorkerScheduleStateSchema,
	WorkerStatusFilterSchema,
	WorkerSummarySchema,
	WorkerWatchdogStateSchema,
} from "@reelvault/sdk/common";
import { t } from "elysia";
import { adminWorkerOperationsService } from "@/app/admin/admin-worker-operations.service";
import { routeLimit } from "@/app/http/middleware/rate-limit.middleware";
import { PaginationSchema, ROUTE_ERRORS } from "@/app/http/schemas/common.schema";
import { JobIdParams, OperationIdParams, WorkerIdParams } from "@/app/http/schemas/route-params.schema";
import { actorContext } from "@/app/http/utils/audit-context.utils";
import { adminShell } from "./admin-shell.routes";

/** Shared body for the three cancel endpoints. */
function toCancelPendingResponse(count: number) {
	return { success: true as const, cancelledCount: count };
}

export const adminWorkersRoutes = adminShell({ tags: ["Admin"] })
	.model({
		"admin.workerSummaries": t.Array(WorkerSummarySchema),
		"admin.workerJobs": PaginatedResponseSchema(WorkerJobSchema),
		"admin.workerJob": WorkerJobSchema,
		"admin.workerOperation": WorkerOperationSchema,
		"admin.workerOperations": PaginatedResponseSchema(WorkerOperationSchema),
		"admin.workerOperationJobsResponse": WorkerOperationJobsResponseSchema,
		"admin.workerTriggers": t.Array(TaskTriggerSchema),
		"admin.workerRunResponse": t.Object({
			success: t.Literal(true),
			jobId: t.String(),
			operationId: t.Optional(t.String()),
		}),
		"admin.workerCategoryRunResponse": WorkerCategoryRunResponseSchema,
		"admin.cancelPendingResponse": t.Object({
			success: t.Literal(true),
			cancelledCount: t.Integer({ minimum: 0 }),
		}),
		"admin.purgeHistoryResponse": PurgeWorkerHistoryResponseSchema,
	})

	.get("/workers", async () => await adminWorkerOperationsService.getWorkerSummaries(), {
		rateLimit: routeLimit("admin-workers-list", 120),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.workerSummaries" },
		detail: { description: "List registered workers with queue statistics, schedules/triggers, and last execution state." },
	})
	.get("/workers/watchdog", () => adminWorkerOperationsService.getWatchdogState(), {
		rateLimit: routeLimit("admin-workers-watchdog", 120),
		response: { ...ROUTE_ERRORS.ADMIN, 200: WorkerWatchdogStateSchema },
		detail: {
			description: "Polling stalls and orphaned-job recoveries of the worker watchdog, counted since this server process started.",
		},
	})
	.post(
		"/workers/:workerId/run",
		async ({ params, body, user, request }) => {
			return await adminWorkerOperationsService.runWorker(params.workerId, body, actorContext({ user, request }));
		},
		{
			rateLimit: routeLimit("admin-workers-run", 20),
			params: WorkerIdParams,
			// Arbitrary worker payload — each worker validates its own `data` shape.
			body: t.Optional(t.Unknown()),
			response: { ...ROUTE_ERRORS.ADMIN_CONFLICT, 200: "admin.workerRunResponse" },
			detail: { description: "Manually trigger immediate execution of a worker task." },
		},
	)
	.post(
		"/workers/categories/:category/run",
		async ({ params, user, request }) => {
			return await adminWorkerOperationsService.runWorkerCategory(params.category, actorContext({ user, request }));
		},
		{
			rateLimit: routeLimit("admin-workers-category-run", 20),
			params: t.Object({ category: WorkerCategorySchema }),
			response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.workerCategoryRunResponse" },
			detail: { description: "Run every registered worker of a category; workers already queued or running are skipped." },
		},
	)
	.post(
		"/workers/:workerId/cancel",
		async ({ params, user, request }) => {
			const { count } = await adminWorkerOperationsService.cancelPendingItems(params.workerId, actorContext({ user, request }));

			return toCancelPendingResponse(count);
		},
		{
			rateLimit: routeLimit("admin-workers-cancel", 20),
			params: WorkerIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.cancelPendingResponse" },
			detail: { description: "Cancel active and pending tasks in a specific worker queue." },
		},
	)
	.put(
		"/workers/:workerId/triggers",
		async ({ params, body, user, request }) => {
			return await adminWorkerOperationsService.updateWorkerTriggers(params.workerId, body.triggers, actorContext({ user, request }));
		},
		{
			rateLimit: routeLimit("admin-workers-triggers", 20),
			params: WorkerIdParams,
			body: UpdateTaskTriggersRequestSchema,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.workerTriggers" },
			detail: { description: "Update triggers and schedule for a worker (startup, daily, weekly, interval)." },
		},
	)
	.put(
		"/workers/:workerId/enabled",
		async ({ params, body, user, request }) =>
			await adminWorkerOperationsService.setScheduleEnabled(params.workerId, body.enabled, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-workers-enabled", 20),
			params: WorkerIdParams,
			body: WorkerScheduleEnabledRequestSchema,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: WorkerScheduleStateSchema },
			detail: { description: "Pause (enabled: false) or resume a worker's scheduled runs. Manual runs are not affected." },
		},
	)
	.post(
		"/workers/cancel-all",
		async ({ user, request }) => {
			const { count } = await adminWorkerOperationsService.cancelPendingItems(undefined, actorContext({ user, request }));

			return toCancelPendingResponse(count);
		},
		{
			rateLimit: routeLimit("admin-workers-cancel-all", 10),
			response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.cancelPendingResponse" },
			detail: { description: "Cancel all pending items across all worker queues." },
		},
	)
	.post(
		"/workers/purge-history",
		async ({ body, user, request }) => {
			return await adminWorkerOperationsService.purgeHistory(body ?? {}, actorContext({ user, request }));
		},
		{
			rateLimit: routeLimit("admin-workers-purge-history", 10),
			body: t.Optional(PurgeWorkerHistoryOptionsSchema),
			response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.purgeHistoryResponse" },
			detail: {
				description:
					"Purge completed, failed, or cancelled historical worker jobs and operations. With `dryRun: true` nothing is deleted and the response counts what a purge would remove.",
			},
		},
	)

	.get("/workers/jobs", async ({ query }) => await adminWorkerOperationsService.getItems(query), {
		rateLimit: routeLimit("admin-workers-jobs-list", 120),
		query: t.Composite([
			PaginationSchema,
			t.Object({
				workerId: t.Optional(t.String({ maxLength: 128 })),
				status: t.Optional(WorkerJobStateSchema),
			}),
		]),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.workerJobs" },
		detail: { description: "List queued, running, and finished worker jobs, one page at a time, filtered by worker and status." },
	})
	.get("/workers/jobs/:jobId", async ({ params }) => await adminWorkerOperationsService.getItem(params.jobId), {
		rateLimit: routeLimit("admin-workers-jobs-get", 120),
		params: JobIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.workerJob" },
		detail: { description: "Retrieve a single worker job with its status, progress, and result/error." },
	})
	.post(
		"/workers/jobs/:jobId/cancel",
		async ({ params, user, request }) => await adminWorkerOperationsService.cancelItem(params.jobId, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-workers-jobs-cancel", 30),
			params: JobIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_CONFLICT, 200: SuccessResponseSchema },
			detail: { description: "Cancel a pending or running worker job." },
		},
	)

	.post(
		"/workers/jobs/:jobId/retry",
		async ({ params, user, request }) => await adminWorkerOperationsService.retryItem(params.jobId, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-workers-jobs-retry", 30),
			params: JobIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_CONFLICT, 200: WorkerRetryResponseSchema },
			detail: { description: "Re-enqueue a failed worker job as a new task with the same payload; the failed job stays in its history." },
		},
	)
	.get("/workers/operations", async ({ query }) => await adminWorkerOperationsService.getOperations(query), {
		rateLimit: routeLimit("admin-workers-operations-list", 120),
		query: t.Composite([PaginationSchema, t.Object({ status: t.Optional(WorkerStatusFilterSchema) })]),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.workerOperations" },
		detail: { description: "List worker operations with progress percent and status." },
	})
	.post(
		"/workers/operations/cancel-all",
		async ({ user, request }) => {
			const { count } = await adminWorkerOperationsService.cancelAllOperations(actorContext({ user, request }));

			return toCancelPendingResponse(count);
		},
		{
			rateLimit: routeLimit("admin-workers-operations-cancel-all", 10),
			response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.cancelPendingResponse" },
			detail: { description: "Cancel all active worker operations and their underlying jobs." },
		},
	)
	.post(
		"/workers/operations/:operationId/resume",
		async ({ params, user, request }) =>
			await adminWorkerOperationsService.resumeOperation(params.operationId, actorContext({ user, request })),
		{
			params: OperationIdParams,
			rateLimit: routeLimit("admin-workers-operations-resume", 20),
			response: { ...ROUTE_ERRORS.ADMIN_CONFLICT, 200: t.Object({ success: t.Literal(true), resumed: t.Integer({ minimum: 0 }) }) },
			detail: { description: "Re-enqueue the cancelled tasks of a stopped worker operation." },
		},
	)
	.get("/workers/operations/:operationId", async ({ params }) => await adminWorkerOperationsService.getOperation(params.operationId), {
		rateLimit: routeLimit("admin-workers-operations-get", 120),
		params: OperationIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.workerOperation" },
		detail: { description: "Retrieve a specific worker operation batch with progress counters." },
	})
	.get(
		"/workers/operations/:operationId/jobs",
		async ({ params, query }) => await adminWorkerOperationsService.getOperationItems(params.operationId, query),
		{
			rateLimit: routeLimit("admin-workers-operations-jobs", 120),
			params: OperationIdParams,
			query: t.Composite([
				PaginationSchema,
				t.Object({
					status: t.Optional(WorkerJobStateSchema),
					q: t.Optional(t.String()),
				}),
			]),
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.workerOperationJobsResponse" },
			detail: { description: "List paginated jobs belonging to an operation." },
		},
	)
	.post(
		"/workers/operations/:operationId/cancel",
		async ({ params, user, request }) =>
			await adminWorkerOperationsService.cancelOperation(params.operationId, actorContext({ user, request })),
		{
			rateLimit: routeLimit("admin-workers-operations-cancel", 20),
			params: OperationIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_CONFLICT, 200: SuccessResponseSchema },
			detail: { description: "Cancel an entire worker operation batch and all its underlying jobs." },
		},
	);
