import type { TaskTrigger } from "@reelvault/sdk/common";
import { eq, inArray, sql } from "drizzle-orm";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import type { DatabaseTransaction } from "@/integrations/drizzle-orm/database.types";
import { forEachChunked } from "@/integrations/drizzle-orm/query/table-access/chunking.utils";
import { defineTableAccess } from "@/integrations/drizzle-orm/query/table-access/table-access.factory";
import { runInTransaction } from "@/integrations/drizzle-orm/query/transaction.utils";
import { toMap } from "@/utils/array.utils";
import type { WorkerExecutionRecord } from "@/workers/worker.ports";

const schedules = schema.workerSchedules;
const schedulesAccess = defineTableAccess("workerSchedules", { primaryKeyColumn: "id" });

class WorkerSchedulesRepository {
	async getAllTriggers(): Promise<Map<string, TaskTrigger[]>> {
		const rows = await this.readAllRows();
		const map = new Map<string, TaskTrigger[]>();
		for (const row of rows) {
			map.set(row.workerId, Array.isArray(row.triggers) ? row.triggers : []);
		}

		return map;
	}

	async getAllSchedules(): Promise<Map<string, typeof schedules.$inferSelect>> {
		const rows = await this.readAllRows();

		return toMap(rows, (row) => row.workerId);
	}

	private async readAllRows(): Promise<Array<typeof schedules.$inferSelect>> {
		return await databaseFactory.getClient().select().from(schedules);
	}

	async getConfiguredWorkerIds(): Promise<string[]> {
		const rows = await databaseFactory.getClient().select({ workerId: schedules.workerId }).from(schedules);

		return rows.map((r) => r.workerId);
	}

	async getSchedule(workerId: string) {
		const [row] = await databaseFactory.getClient().select().from(schedules).where(eq(schedules.workerId, workerId)).limit(1);

		return row;
	}

	/** Persists the scheduling deadline; creates a telemetry-only row when none exists yet. */
	async setNextRunAt(workerId: string, nextRunAt: Date | null): Promise<void> {
		const now = new Date();
		if (!nextRunAt) {
			// Clear a stale deadline. Previously a null next-run left the old past
			// deadline in place, so a schedule that no longer fires re-fired every
			// minute (due <= now forever).
			await databaseFactory.getClient().update(schedules).set({ nextRunAt: null, updatedAt: now }).where(eq(schedules.workerId, workerId));

			return;
		}

		await schedulesAccess.upsert({
			values: { id: Bun.randomUUIDv7(), workerId, triggers: [], isEnabled: true, nextRunAt },
			target: schedulesAccess.table.workerId,
			set: { nextRunAt, updatedAt: now },
		});
	}

	/** Pauses (`false`) or resumes (`true`) the scheduled runs of one worker; manual runs ignore this flag. */
	async setEnabled(workerId: string, enabled: boolean): Promise<void> {
		const now = new Date();
		await schedulesAccess.upsert({
			values: { id: Bun.randomUUIDv7(), workerId, triggers: [], isEnabled: enabled },
			target: schedulesAccess.table.workerId,
			set: { isEnabled: enabled, updatedAt: now },
		});
	}

	/**
	 * Batch variant of {@link setNextRunAt} for the scheduler pass: one multi-row
	 * upsert for armed/advanced deadlines, one chunked UPDATE for cleared ones.
	 * Replaces one write per registered worker on startup and per due worker.
	 */
	async setNextRunAtMany(entries: ReadonlyArray<{ workerId: string; nextRunAt: Date | null }>): Promise<void> {
		if (entries.length === 0) return;

		const now = new Date();
		const scheduled = entries.filter((entry): entry is { workerId: string; nextRunAt: Date } => entry.nextRunAt !== null);
		if (scheduled.length > 0) {
			await forEachChunked(scheduled, async (chunk) => {
				await schedulesAccess.upsert({
					values: chunk.map((entry) => ({
						id: Bun.randomUUIDv7(),
						workerId: entry.workerId,
						triggers: [],
						isEnabled: true,
						nextRunAt: entry.nextRunAt,
					})),
					target: schedulesAccess.table.workerId,
					set: { nextRunAt: sql`excluded.next_run_at`, updatedAt: now },
				});
			});
		}

		const cleared = entries.filter((entry) => entry.nextRunAt === null).map((entry) => entry.workerId);
		if (cleared.length > 0) {
			await forEachChunked(cleared, async (chunk) => {
				await databaseFactory
					.getClient()
					.update(schedules)
					.set({ nextRunAt: null, updatedAt: now })
					.where(inArray(schedules.workerId, chunk));
			});
		}
	}

	async setTriggers(workerId: string, triggers: TaskTrigger[], tx?: DatabaseTransaction): Promise<void> {
		await runInTransaction(tx, async (targetTx) => {
			const now = new Date();
			await schedulesAccess.upsert({
				values: {
					id: Bun.randomUUIDv7(),
					workerId,
					triggers,
					isEnabled: true,
				},
				target: schedulesAccess.table.workerId,
				set: {
					triggers,
					updatedAt: now,
				},
				tx: targetTx,
			});
		});
	}

	async updateExecution(workerId: string, execution: WorkerExecutionRecord, tx?: DatabaseTransaction): Promise<void> {
		await runInTransaction(tx, async (targetTx) => {
			const now = new Date();
			const lastRunAt = execution.startedAt ?? execution.completedAt;
			await schedulesAccess.upsert({
				values: {
					id: Bun.randomUUIDv7(),
					workerId,
					triggers: [],
					isEnabled: true,
					lastRunAt,
					lastCompletedAt: execution.completedAt,
					lastStatus: execution.status,
					lastDurationMs: execution.durationMs,
					lastError: execution.error ?? null,
				},
				target: schedulesAccess.table.workerId,
				set: {
					lastRunAt,
					lastCompletedAt: execution.completedAt,
					lastStatus: execution.status,
					lastDurationMs: execution.durationMs,
					lastError: execution.error ?? null,
					updatedAt: now,
				},
				tx: targetTx,
			});
		});
	}
}

export const workerSchedulesRepository = new WorkerSchedulesRepository();
