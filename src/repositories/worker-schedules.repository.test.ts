import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { workerSchedulesRepository } from "./worker-schedules.repository";

const { client } = useTestDatabase();

function nextRunAtSeconds(): Record<string, number | null> {
	const rows = client().all<{ worker_id: string; next_run_at: number | null }>(
		sql`SELECT worker_id, next_run_at FROM worker_schedules ORDER BY worker_id`,
	);

	return Object.fromEntries(rows.map((row) => [row.worker_id, row.next_run_at]));
}

describe("workerSchedulesRepository.setNextRunAtMany", () => {
	test("upserts armed deadlines, clears an existing deadline, and creates no row for a null one", async () => {
		await workerSchedulesRepository.setNextRunAt("w-1", new Date("2026-01-01T00:00:00Z"));
		await workerSchedulesRepository.setNextRunAt("w-3", new Date("2026-01-01T00:00:00Z"));

		const first = new Date("2026-02-01T00:00:00Z");
		const second = new Date("2026-03-01T00:00:00Z");
		await workerSchedulesRepository.setNextRunAtMany([
			{ workerId: "w-1", nextRunAt: first },
			{ workerId: "w-2", nextRunAt: second },
			{ workerId: "w-3", nextRunAt: null },
			{ workerId: "w-4", nextRunAt: null },
		]);

		expect(nextRunAtSeconds()).toEqual({
			"w-1": Math.floor(first.getTime() / 1000),
			"w-2": Math.floor(second.getTime() / 1000),
			"w-3": null,
		});
	});
});
