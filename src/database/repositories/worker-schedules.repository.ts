import type { TaskTrigger } from "@reelvault/sdk/common";
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { databaseFactory } from "@/database/database";
import { schema } from "@/database/schema";
import type { DatabaseTransaction } from "@/database/types";

const schedules = schema.workerSchedules;

export interface WorkerExecutionRecord {
	status: "completed" | "failed" | "cancelled";
	startedAt?: Date | undefined;
	completedAt: Date;
	durationMs: number;
	error?: string | undefined;
}

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

		return new Map(rows.map((row) => [row.workerId, row]));
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

		await databaseFactory
			.getClient()
			.insert(schedules)
			.values({ id: uuidv7(), workerId, triggers: [], isEnabled: true, nextRunAt })
			.onConflictDoUpdate({
				target: schedules.workerId,
				set: { nextRunAt, updatedAt: now },
			});
	}

	async setTriggers(workerId: string, triggers: TaskTrigger[], tx?: DatabaseTransaction): Promise<void> {
		const runner = async (targetTx: DatabaseTransaction) => {
			const client = databaseFactory.getClient({ tx: targetTx });
			const now = new Date();
			await client
				.insert(schedules)
				.values({
					id: uuidv7(),
					workerId,
					triggers,
					isEnabled: true,
				})
				.onConflictDoUpdate({
					target: schedules.workerId,
					set: {
						triggers,
						updatedAt: now,
					},
				});
		};
		if (tx) {
			await runner(tx);
		} else {
			await databaseFactory.transaction(runner);
		}
	}

	async updateExecution(workerId: string, execution: WorkerExecutionRecord, tx?: DatabaseTransaction): Promise<void> {
		const runner = async (targetTx: DatabaseTransaction) => {
			const client = databaseFactory.getClient({ tx: targetTx });
			const now = new Date();
			const lastRunAt = execution.startedAt ?? execution.completedAt;
			await client
				.insert(schedules)
				.values({
					id: uuidv7(),
					workerId,
					triggers: [],
					isEnabled: true,
					lastRunAt,
					lastCompletedAt: execution.completedAt,
					lastStatus: execution.status,
					lastDurationMs: execution.durationMs,
					lastError: execution.error ?? null,
				})
				.onConflictDoUpdate({
					target: schedules.workerId,
					set: {
						lastRunAt,
						lastCompletedAt: execution.completedAt,
						lastStatus: execution.status,
						lastDurationMs: execution.durationMs,
						lastError: execution.error ?? null,
						updatedAt: now,
					},
				});
		};
		if (tx) {
			await runner(tx);
		} else {
			await databaseFactory.transaction(runner);
		}
	}
}

export const workerSchedulesRepository = new WorkerSchedulesRepository();
