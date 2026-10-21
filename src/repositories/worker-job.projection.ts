import type { InferSelectModel, SQL } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";

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

/** One row of the worker-job summary projection. */
export type WorkerJobSummaryRow = Pick<InferSelectModel<typeof schema.workerJobs>, keyof typeof workerJobSummaryColumns>;

/**
 * Reads one page of worker-job summary rows.
 *
 * The job list and the operation list project the same columns over the same
 * table, so they share this reader.
 */
export async function readWorkerJobSummaryPage(
	client: DatabaseTransaction,
	page: { where?: SQL | undefined; orderBy: SQL; limit: number; offset: number },
): Promise<WorkerJobSummaryRow[]> {
	return await client
		.select(workerJobSummaryColumns)
		.from(job)
		.where(page.where)
		.orderBy(page.orderBy)
		.limit(page.limit)
		.offset(page.offset);
}
