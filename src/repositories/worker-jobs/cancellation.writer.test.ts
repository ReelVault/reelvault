import { describe, expect, test } from "bun:test";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { cancelAllRunning } from "./cancellation.writer";

const testDb = useTestDatabase();

describe("cancelAllRunning", () => {
	test("derives operation counters from the rows it actually cancelled", async () => {
		const db = testDb.sqlite();
		const now = Math.floor(Date.now() / 1000);
		db.run(
			"INSERT INTO worker_operations (id, type, status, cancel_requested, total_items, pending_items, running_items, completed_items, failed_items, cancelled_items, created_at, updated_at) VALUES ('op-1','test','running',1,2,0,2,0,0,0,?,?)",
			[now, now],
		);
		for (const id of ["job-1", "job-2"]) {
			db.run(
				"INSERT INTO worker_jobs (id, worker_id, operation_id, data, status, run_at, created_at, updated_at) VALUES (?, 'w-1', 'op-1', '{}', 'running', ?, ?, ?)",
				[id, now, now, now],
			);
		}

		const cancelled = await cancelAllRunning("w-1");

		expect(cancelled).toBe(2);
		const operation = db
			.query("SELECT status, running_items AS running, cancelled_items AS cancelled FROM worker_operations WHERE id = 'op-1'")
			.get() as { status: string; running: number; cancelled: number };
		expect(operation).toEqual({ status: "cancelled", running: 0, cancelled: 2 });

		const jobs = db.query("SELECT COUNT(*) AS count FROM worker_jobs WHERE status = 'cancelled'").get() as { count: number };
		expect(jobs.count).toBe(2);
	});
});
