import type { AdminUpdateHistoryEntry, AdminUpdateHistoryPage } from "@reelvault/sdk/common";
import {
	type UpdateHistoryOutcome,
	type UpdateHistoryRepository,
	type UpdateHistoryStart,
	updateHistoryRepository,
} from "@/app/repositories/update-history.repository";
import { QueryPagination } from "@/integrations/drizzle-orm/query/pagination.utils";
import { createLogger } from "@/utils/logger.utils";
import { runSafely } from "@/utils/safe-execute.utils";

type UpdateHistoryRow = Awaited<ReturnType<UpdateHistoryRepository["findPage"]>>["data"][number];

const INTERRUPTED_MESSAGE = "Interrupted before it finished";

function toHistoryEntry(row: UpdateHistoryRow): AdminUpdateHistoryEntry {
	return {
		id: row.id,
		action: row.action,
		target: row.target,
		status: row.status,
		fromVersion: row.fromVersion,
		toVersion: row.toVersion,
		errorMessage: row.errorMessage,
		actorUserId: row.actorUserId,
		startedAt: row.startedAt.toISOString(),
		finishedAt: row.finishedAt?.toISOString() ?? null,
	};
}

/**
 * Records every install and rollback run. Writes never throw: a failed history
 * write must not change the outcome of the update it describes.
 */
export class UpdateHistoryService {
	readonly serviceName = "UpdateHistoryService";
	readonly logger = createLogger("UpdateHistoryService");

	/** Opens a run and returns its id, or null when the run could not be recorded. */
	async begin(run: UpdateHistoryStart): Promise<string | null> {
		try {
			return await updateHistoryRepository.insert(run, new Date());
		} catch (error) {
			this.logger.warn("Could not record the update run", { error });

			return null;
		}
	}

	async succeed(id: string | null): Promise<void> {
		await this.finish(id, { status: "succeeded", errorMessage: null, finishedAt: new Date() });
	}

	async fail(id: string | null, errorMessage: string): Promise<void> {
		await this.finish(id, { status: "failed", errorMessage, finishedAt: new Date() });
	}

	/** An install stopped before it replaced any file. It is not a failure, so no failure is recorded. */
	async cancel(id: string | null): Promise<void> {
		await this.finish(id, { status: "cancelled", errorMessage: null, finishedAt: new Date() });
	}

	/**
	 * Settles runs still marked as running when the server starts. A server run
	 * succeeded when this process runs the version it installed; that can only be
	 * known after the restart, so server runs stay open until then. Any other run
	 * left open was cut short.
	 */
	async settleRunsAfterStart(runningServerVersion: string): Promise<void> {
		try {
			const finishedAt = new Date();
			for (const run of await updateHistoryRepository.findRunning()) {
				const succeeded = run.target === "server" && run.toVersion === runningServerVersion;
				await updateHistoryRepository.finish(run.id, {
					status: succeeded ? "succeeded" : "failed",
					errorMessage: succeeded ? null : INTERRUPTED_MESSAGE,
					finishedAt,
				});
			}
		} catch (error) {
			this.logger.warn("Could not settle the update runs left open", { error });
		}
	}

	async list(query: { page?: number | undefined; limit?: number | undefined }): Promise<AdminUpdateHistoryPage> {
		return await runSafely(this, "list", async () => {
			const pagination = QueryPagination.resolvePageParams(query, { defaultLimit: 20 });
			const result = await updateHistoryRepository.findPage({ limit: pagination.limit, offset: pagination.offset });

			return {
				...QueryPagination.buildAdminPagination({ total: result.total, page: pagination.page, limit: pagination.limit }),
				data: result.data.map(toHistoryEntry),
			};
		});
	}

	private async finish(id: string | null, outcome: UpdateHistoryOutcome): Promise<void> {
		if (!id) return;

		try {
			await updateHistoryRepository.finish(id, outcome);
		} catch (error) {
			this.logger.warn("Could not record the update outcome", { error });
		}
	}
}

export const updateHistoryService = new UpdateHistoryService();
