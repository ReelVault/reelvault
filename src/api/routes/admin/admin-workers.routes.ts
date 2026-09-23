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
	WorkerOperationJobsResponseSchema,
	WorkerOperationSchema,
	WorkerSummarySchema,
} from "@sdk/common";
import { Elysia, t } from "elysia";
import { ClampedNumeric, commonModel, PaginationSchema, ROUTE_ERRORS } from "@/api/schemas/common.schemas";
import { OperationIdParams, WorkerIdParams } from "@/api/schemas/route-params";
import { adminWorkerOperationsService } from "@/application/admin/admin-worker-operations.service";
import { authMiddleware } from "@/middleware/auth.middleware";
import { rateLimitMiddleware } from "@/middleware/rate-limit.middleware";

/** Shared body for the three cancel endpoints. */
function toCancelPendingResponse(count: number) {
	return { success: true as const, cancelledCount: count };
}

export const adminWorkersRoutes = new Elysia()
	.use(commonModel)
	.use(authMiddleware)
	.use(rateLimitMiddleware)
	.model({
		"admin.workerSummaries": t.Array(WorkerSummarySchema),
		"admin.workerJobs": t.Array(WorkerJobSchema),
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
	.guard({ adminOnly: true })

	.get("/workers", async () => await adminWorkerOperationsService.getWorkerSummaries(), {
		rateLimit: { name: "admin-workers-list", max: 120, windowMs: 60_000 },
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.workerSummaries" },
		detail: { description: "List registered workers with queue statistics, schedules/triggers, and last execution state." },
	})
	.post(
		"/workers/:workerId/run",
		async ({ params, body, user, request }) => {
			return await adminWorkerOperationsService.runWorker(params.workerId, body, user?.id, request.headers);
		},
		{
			rateLimit: { name: "admin-workers-run", max: 20, windowMs: 60_000 },
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
			return await adminWorkerOperationsService.runWorkerCategory(params.category, user?.id, request.headers);
		},
		{
			rateLimit: { name: "admin-workers-category-run", max: 20, windowMs: 60_000 },
			params: t.Object({ category: WorkerCategorySchema }),
			response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.workerCategoryRunResponse" },
			detail: { description: "Run every registered worker of a category; workers already queued or running are skipped." },
		},
	)
	.post(
		"/workers/:workerId/cancel",
		async ({ params, user, request }) => {
			const { count } = await adminWorkerOperationsService.cancelPendingItems(params.workerId, user?.id, request.headers);

			return toCancelPendingResponse(count);
		},
		{
			rateLimit: { name: "admin-workers-cancel", max: 20, windowMs: 60_000 },
			params: WorkerIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.cancelPendingResponse" },
			detail: { description: "Cancel active and pending tasks in a specific worker queue." },
		},
	)
	.put(
		"/workers/:workerId/triggers",
		async ({ params, body, user, request }) => {
			return await adminWorkerOperationsService.updateWorkerTriggers(params.workerId, body.triggers, user?.id, request.headers);
		},
		{
			rateLimit: { name: "admin-workers-triggers", max: 20, windowMs: 60_000 },
			params: WorkerIdParams,
			body: UpdateTaskTriggersRequestSchema,
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.workerTriggers" },
			detail: { description: "Update triggers and schedule for a worker (startup, daily, weekly, interval, cron)." },
		},
	)
	.post(
		"/workers/cancel-all",
		async ({ user, request }) => {
			const { count } = await adminWorkerOperationsService.cancelPendingItems(undefined, user?.id, request.headers);

			return toCancelPendingResponse(count);
		},
		{
			rateLimit: { name: "admin-workers-cancel-all", max: 10, windowMs: 60_000 },
			response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.cancelPendingResponse" },
			detail: { description: "Cancel all pending items across all worker queues." },
		},
	)
	.post(
		"/workers/purge-history",
		async ({ body, user, request }) => {
			return await adminWorkerOperationsService.purgeHistory(body ?? {}, user?.id, request.headers);
		},
		{
			rateLimit: { name: "admin-workers-purge-history", max: 10, windowMs: 60_000 },
			body: t.Optional(PurgeWorkerHistoryOptionsSchema),
			response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.purgeHistoryResponse" },
			detail: { description: "Purge completed, failed, or cancelled historical worker jobs and operations." },
		},
	)

	.get("/workers/jobs", async ({ query }) => await adminWorkerOperationsService.getItems(query.limit, query.workerId), {
		rateLimit: { name: "admin-workers-jobs-list", max: 120, windowMs: 60_000 },
		query: t.Object({
			limit: t.Optional(ClampedNumeric(1, 100)),
			workerId: t.Optional(t.String({ maxLength: 128 })),
		}),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.workerJobs" },
		detail: { description: "List queued, running, and finished worker jobs." },
	})
	.get("/workers/jobs/:jobId", async ({ params }) => await adminWorkerOperationsService.getItem(params.jobId), {
		rateLimit: { name: "admin-workers-jobs-get", max: 120, windowMs: 60_000 },
		params: t.Object({ jobId: t.String({ minLength: 1 }) }),
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.workerJob" },
		detail: { description: "Retrieve a single worker job with its status, progress, and result/error." },
	})
	.post(
		"/workers/jobs/:jobId/cancel",
		async ({ params, user, request }) => await adminWorkerOperationsService.cancelItem(params.jobId, user?.id, request.headers),
		{
			rateLimit: { name: "admin-workers-jobs-cancel", max: 30, windowMs: 60_000 },
			params: t.Object({ jobId: t.String({ minLength: 1 }) }),
			response: { ...ROUTE_ERRORS.ADMIN_CONFLICT, 200: SuccessResponseSchema },
			detail: { description: "Cancel a pending or running worker job." },
		},
	)
	.delete(
		"/workers/jobs/:jobId",
		async ({ params, user, request }) => await adminWorkerOperationsService.cancelItem(params.jobId, user?.id, request.headers),
		{
			rateLimit: { name: "admin-workers-jobs-delete", max: 30, windowMs: 60_000 },
			params: t.Object({ jobId: t.String({ minLength: 1 }) }),
			response: { ...ROUTE_ERRORS.ADMIN_CONFLICT, 200: SuccessResponseSchema },
			detail: { description: "Cancel a pending or running worker job (DELETE alias)." },
		},
	)

	.get("/workers/operations", async ({ query }) => await adminWorkerOperationsService.getOperations(query), {
		rateLimit: { name: "admin-workers-operations-list", max: 120, windowMs: 60_000 },
		query: t.Composite([
			PaginationSchema,
			t.Object({
				status: t.Optional(
					t.Union([
						t.Literal("pending"),
						t.Literal("running"),
						t.Literal("completed"),
						t.Literal("failed"),
						t.Literal("cancelled"),
						t.Literal("active"),
					]),
				),
			}),
		]),
		response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.workerOperations" },
		detail: { description: "List worker operations with progress percent and status." },
	})
	.post(
		"/workers/operations/cancel-all",
		async ({ user, request }) => {
			const { count } = await adminWorkerOperationsService.cancelAllOperations(user?.id, request.headers);

			return toCancelPendingResponse(count);
		},
		{
			rateLimit: { name: "admin-workers-operations-cancel-all", max: 10, windowMs: 60_000 },
			response: { ...ROUTE_ERRORS.ADMIN, 200: "admin.cancelPendingResponse" },
			detail: { description: "Cancel all active worker operations and their underlying jobs." },
		},
	)
	.post(
		"/workers/operations/:operationId/resume",
		async ({ params, user, request }) => await adminWorkerOperationsService.resumeOperation(params.operationId, user?.id, request.headers),
		{
			params: OperationIdParams,
			rateLimit: { name: "admin-workers-operations-resume", max: 20, windowMs: 60_000 },
			response: { ...ROUTE_ERRORS.ADMIN_CONFLICT, 200: t.Object({ success: t.Literal(true), resumed: t.Integer({ minimum: 0 }) }) },
			detail: { description: "Re-enqueue the cancelled tasks of a stopped worker operation." },
		},
	)
	.get("/workers/operations/:operationId", async ({ params }) => await adminWorkerOperationsService.getOperation(params.operationId), {
		rateLimit: { name: "admin-workers-operations-get", max: 120, windowMs: 60_000 },
		params: OperationIdParams,
		response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.workerOperation" },
		detail: { description: "Retrieve a specific worker operation batch with progress counters." },
	})
	.get(
		"/workers/operations/:operationId/jobs",
		async ({ params, query }) => await adminWorkerOperationsService.getOperationItems(params.operationId, query),
		{
			rateLimit: { name: "admin-workers-operations-jobs", max: 120, windowMs: 60_000 },
			params: OperationIdParams,
			query: t.Composite([
				PaginationSchema,
				t.Object({
					status: t.Optional(
						t.Union([t.Literal("pending"), t.Literal("running"), t.Literal("completed"), t.Literal("failed"), t.Literal("cancelled")]),
					),
					search: t.Optional(t.String()),
				}),
			]),
			response: { ...ROUTE_ERRORS.ADMIN_NOT_FOUND, 200: "admin.workerOperationJobsResponse" },
			detail: { description: "List paginated jobs belonging to an operation." },
		},
	)
	.post(
		"/workers/operations/:operationId/cancel",
		async ({ params, user, request }) => await adminWorkerOperationsService.cancelOperation(params.operationId, user?.id, request.headers),
		{
			rateLimit: { name: "admin-workers-operations-cancel", max: 20, windowMs: 60_000 },
			params: OperationIdParams,
			response: { ...ROUTE_ERRORS.ADMIN_CONFLICT, 200: SuccessResponseSchema },
			detail: { description: "Cancel an entire worker operation batch and all its underlying jobs." },
		},
	);
