import { t } from "elysia";
import type { Logger } from "./logger";
import { TaskLastExecutionSchema, type TaskTrigger, TaskTriggerSchema } from "./scheduled-tasks";

export const WorkerJobStateSchema = t.Union([
	t.Literal("pending"),
	t.Literal("running"),
	t.Literal("completed"),
	t.Literal("failed"),
	t.Literal("cancelled"),
]);

export const WorkerJobSchema = t.Object({
	id: t.String(),
	workerId: t.String(),
	operationId: t.Optional(t.String()),
	dependsOnTaskIds: t.Array(t.String()),
	status: WorkerJobStateSchema,
	priority: t.Integer(),
	attempts: t.Integer({ minimum: 0 }),
	maxAttempts: t.Integer({ minimum: 1 }),
	dedupeKey: t.Optional(t.String()),
	referenceType: t.Optional(t.String()),
	referenceId: t.Optional(t.String()),
	runnerId: t.Optional(t.String()),
	progressPercent: t.Optional(t.Nullable(t.Integer({ minimum: 0, maximum: 100 }))),
	result: t.Optional(t.Unknown()),
	error: t.Optional(t.String()),
	runAt: t.String({ format: "date-time" }),
	startedAt: t.Optional(t.String({ format: "date-time" })),
	completedAt: t.Optional(t.String({ format: "date-time" })),
	createdAt: t.String({ format: "date-time" }),
	updatedAt: t.String({ format: "date-time" }),
});

export type WorkerJob = typeof WorkerJobSchema.static;

export const WorkerOperationItemsSummarySchema = t.Object({
	total: t.Integer({ minimum: 0 }),
	pending: t.Integer({ minimum: 0 }),
	running: t.Integer({ minimum: 0 }),
	completed: t.Integer({ minimum: 0 }),
	failed: t.Integer({ minimum: 0 }),
	cancelled: t.Integer({ minimum: 0 }),
});

export const WorkerOperationJobsResponseSchema = t.Object({
	items: t.Array(WorkerJobSchema),
	summary: WorkerOperationItemsSummarySchema,
	page: t.Integer({ minimum: 1 }),
	limit: t.Integer({ minimum: 1 }),
	total: t.Integer({ minimum: 0 }),
	totalPages: t.Integer({ minimum: 0 }),
});

export type WorkerOperationJobsResponse = typeof WorkerOperationJobsResponseSchema.static;

export const WorkerOperationStatusSchema = t.Union([
	t.Literal("pending"),
	t.Literal("running"),
	t.Literal("completed"),
	t.Literal("failed"),
	t.Literal("cancelled"),
]);

export type WorkerOperationStatus = typeof WorkerOperationStatusSchema.static;

export const WorkerOperationSchema = t.Object({
	id: t.String(),
	type: t.String(),
	status: WorkerOperationStatusSchema,
	cancelRequested: t.Boolean(),
	referenceType: t.Optional(t.String()),
	referenceId: t.Optional(t.String()),
	totalItems: t.Integer({ minimum: 0 }),
	pendingItems: t.Integer({ minimum: 0 }),
	runningItems: t.Integer({ minimum: 0 }),
	completedItems: t.Integer({ minimum: 0 }),
	failedItems: t.Integer({ minimum: 0 }),
	cancelledItems: t.Integer({ minimum: 0 }),
	progressPercent: t.Nullable(t.Number({ minimum: 0, maximum: 100 })),
	etaMs: t.Nullable(t.Integer({ minimum: 0 })),
	error: t.Optional(t.String()),
	startedAt: t.Optional(t.String({ format: "date-time" })),
	completedAt: t.Optional(t.String({ format: "date-time" })),
	createdAt: t.String({ format: "date-time" }),
	updatedAt: t.String({ format: "date-time" }),
});

export type WorkerOperation = typeof WorkerOperationSchema.static;

export const OperationQueuedResponseSchema = t.Object({
	success: t.Literal(true),
	operationId: t.String(),
	status: t.Literal("pending"),
});

export type OperationQueuedResponse = typeof OperationQueuedResponseSchema.static;

export const LibraryErrorsCheckRequestSchema = t.Object({
	libraryPaths: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
});

export type LibraryErrorsCheckRequest = typeof LibraryErrorsCheckRequestSchema.static;

export const WorkerQueueStatsSchema = t.Object({
	workerId: t.String(),
	/** Effective concurrency; `0` means hardware-derived auto sizing. */
	concurrency: t.Integer({ minimum: 0 }),
	timeoutMs: t.Integer({ minimum: 1 }),
	waiting: t.Integer({ minimum: 0 }),
	active: t.Integer({ minimum: 0 }),
	completed: t.Integer({ minimum: 0 }),
	failed: t.Integer({ minimum: 0 }),
});

export type WorkerQueueStats = typeof WorkerQueueStatsSchema.static;

/** Single source of truth for the category literals — reused by summaries and admin routes. */
export const WorkerCategorySchema = t.Union([
	t.Literal("library"),
	t.Literal("media"),
	t.Literal("stream"),
	t.Literal("sync"),
	t.Literal("system"),
	t.Literal("plugins"),
	t.Literal("application"),
	t.Literal("database_optimization"),
	t.Literal("file_cleanup"),
]);

export const WorkerCategoryRunResponseSchema = t.Object({
	success: t.Literal(true),
	started: t.Array(t.Object({ workerId: t.String(), jobId: t.String() })),
	skipped: t.Array(t.Object({ workerId: t.String(), reason: t.String() })),
});

export type WorkerCategoryRunResponse = typeof WorkerCategoryRunResponseSchema.static;

export const WorkerSummarySchema = t.Object({
	id: t.String(),
	name: t.String(),
	description: t.Optional(t.String()),
	category: WorkerCategorySchema,
	/** Effective concurrency; `0` means hardware-derived auto sizing. */
	concurrency: t.Integer({ minimum: 0 }),
	timeoutMs: t.Integer({ minimum: 1 }),
	stats: WorkerQueueStatsSchema,
	triggers: t.Array(TaskTriggerSchema),
	lastExecution: t.Optional(TaskLastExecutionSchema),
});

export type WorkerSummary = typeof WorkerSummarySchema.static;

export type WorkerBackoffType = "fixed" | "exponential";

export interface WorkerHandlerContext<TData = unknown> {
	taskId: string;
	workerId: string;
	operationId?: string | undefined;
	data: TData;
	attempt: number;
	signal: AbortSignal;
	logger: Logger;
	updateProgress?: ((percent: number) => Promise<void>) | undefined;
	/**
	 * Re-arms the execution timeout to fire `additionalMs` from now. Long scans
	 * call this after discovering their true workload (or per processed batch),
	 * turning the fixed definition timeout into a stall guard.
	 */
	extendTimeout?: ((additionalMs: number) => void) | undefined;
}

export type WorkerCategory =
	| "library"
	| "media"
	| "stream"
	| "sync"
	| "system"
	| "plugins"
	| "application"
	| "database_optimization"
	| "file_cleanup";

export interface WorkerDefinition<TData = unknown, TResult = unknown> {
	id: string;
	name?: string | undefined;
	description?: string | undefined;
	category?: WorkerCategory | undefined;
	concurrency?: number | undefined;
	timeoutMs?: number | undefined;
	attempts?: number | undefined;
	/** Queue priority applied when an enqueued item does not pass its own (lower runs first). */
	defaultPriority?: number | undefined;
	backoff?: { type: WorkerBackoffType; delayMs: number } | undefined;
	removeOnComplete?: boolean | number | undefined;
	removeOnFail?: boolean | number | undefined;
	defaultTriggers?: TaskTrigger[] | undefined;
	handler(context: WorkerHandlerContext<TData>): Promise<TResult> | TResult;
	schedule?: { cron: string; data?: TData | undefined; operationId?: string | undefined } | undefined;
}

export interface AddWorkerItemOptions {
	operationId?: string | undefined;
	dependsOnTaskIds?: string[] | undefined;
	dependsOnJobId?: string | undefined;
	dedupeKey?: string | undefined;
	reference?: { type: string; id: string } | undefined;
	priority?: number | undefined;
	delayMs?: number | undefined;
	attempts?: number | undefined;
	backoff?: { type: WorkerBackoffType; delayMs: number } | undefined;
}

export const PurgeWorkerHistoryOptionsSchema = t.Object({
	status: t.Optional(t.Union([t.Literal("all_terminal"), t.Literal("completed"), t.Literal("failed"), t.Literal("cancelled")])),
	olderThanDays: t.Optional(t.Integer({ minimum: 0 })),
});

export type PurgeWorkerHistoryOptions = typeof PurgeWorkerHistoryOptionsSchema.static;

export const PurgeWorkerHistoryResponseSchema = t.Object({
	success: t.Literal(true),
	deletedJobsCount: t.Integer({ minimum: 0 }),
	deletedOperationsCount: t.Integer({ minimum: 0 }),
});

export type PurgeWorkerHistoryResponse = typeof PurgeWorkerHistoryResponseSchema.static;
