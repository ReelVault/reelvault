import { schema } from "@/database/schema";

const job = schema.workerJobs;

/**
 * Every worker-job column except the `data` payload blob. Lists and admin views
 * map rows through `toJobContract`, which never reads `data`, so selecting it
 * would only materialize large JSON strings for nothing.
 */
export const workerJobSummaryColumns = {
	id: job.id,
	workerId: job.workerId,
	operationId: job.operationId,
	dependsOnJobId: job.dependsOnJobId,
	dedupeKey: job.dedupeKey,
	referenceType: job.referenceType,
	referenceId: job.referenceId,
	priority: job.priority,
	status: job.status,
	attempts: job.attempts,
	maxAttempts: job.maxAttempts,
	backoffType: job.backoffType,
	backoffDelayMs: job.backoffDelayMs,
	runAt: job.runAt,
	leaseUntil: job.leaseUntil,
	runnerId: job.runnerId,
	claimToken: job.claimToken,
	progressPercent: job.progressPercent,
	result: job.result,
	error: job.error,
	startedAt: job.startedAt,
	completedAt: job.completedAt,
	createdAt: job.createdAt,
	updatedAt: job.updatedAt,
} as const;
