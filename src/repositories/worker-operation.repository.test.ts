import { describe, expect, test } from "bun:test";
import type { DatabaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { workerJobRepository } from "./worker.repository";
import { workerOperationRepository } from "./worker-operation.repository";

const testDb = useTestDatabase();

function insertOperation(
	db: DatabaseFactory["sqlite"],
	id: string,
	status: string,
	retentionSecondsFromNow: number | null,
	nowSeconds: number,
): void {
	db.run(
		"INSERT INTO worker_operations (id, type, status, cancel_requested, total_items, pending_items, running_items, completed_items, failed_items, cancelled_items, retention_until, created_at, updated_at) VALUES (?,?,?,0,0,0,0,0,0,0,?,?,?)",
		[id, "test", status, retentionSecondsFromNow === null ? null : nowSeconds + retentionSecondsFromNow, nowSeconds, nowSeconds],
	);
}

function existingIds(db: DatabaseFactory["sqlite"]): string[] {
	return db
		.query("SELECT id FROM worker_operations ORDER BY id")
		.all()
		.map((row) => (row as { id: string }).id);
}

describe("workerOperationRepository streaming slots", () => {
	function insertStreamOperation(
		db: DatabaseFactory["sqlite"],
		options: { status: string; cancelRequested: number; total: number; running: number; completed?: number; cancelled: number },
	): void {
		const now = Math.floor(Date.now() / 1000);
		db.run(
			"INSERT INTO worker_operations (id, type, status, cancel_requested, total_items, pending_items, running_items, completed_items, failed_items, cancelled_items, created_at, updated_at) VALUES ('op-stream','stream',?,?,?,0,?,?,0,?,?,?)",
			[options.status, options.cancelRequested, options.total, options.running, options.completed ?? 0, options.cancelled, now, now],
		);
	}

	test("a late attach does not resurrect a cancelled operation", async () => {
		const db = testDb.sqlite();
		insertStreamOperation(db, { status: "cancelled", cancelRequested: 1, total: 1, running: 1, cancelled: 0 });

		expect(await workerOperationRepository.markStreamAttached("op-stream")).toBe(false);

		const row = db.query("SELECT status, running_items AS running FROM worker_operations WHERE id = 'op-stream'").get() as {
			status: string;
			running: number;
		};
		expect(row).toEqual({ status: "cancelled", running: 1 });
	});

	test("a natural EOF keeps a cancelled operation cancelled", async () => {
		const db = testDb.sqlite();
		insertStreamOperation(db, { status: "cancelled", cancelRequested: 1, total: 1, running: 1, cancelled: 1 });

		await workerOperationRepository.completeStreamSlot("op-stream");

		const row = db.query("SELECT status, running_items AS running FROM worker_operations WHERE id = 'op-stream'").get() as {
			status: string;
			running: number;
		};
		expect(row).toEqual({ status: "cancelled", running: 0 });
	});

	test("an active operation with no remaining work completes on EOF", async () => {
		const db = testDb.sqlite();
		insertStreamOperation(db, { status: "running", cancelRequested: 0, total: 1, running: 1, completed: 1, cancelled: 0 });

		await workerOperationRepository.completeStreamSlot("op-stream");

		const row = db.query("SELECT status FROM worker_operations WHERE id = 'op-stream'").get() as { status: string };
		expect(row.status).toBe("completed");
	});
});

describe("workerOperationRepository resume accounting", () => {
	test("counts and pages cancelled jobs, pre-sets the resumed total, and only a normal enqueue adds to it", async () => {
		const db = testDb.sqlite();
		const now = Math.floor(Date.now() / 1000);
		db.run(
			"INSERT INTO worker_operations (id, type, status, cancel_requested, total_items, pending_items, running_items, completed_items, failed_items, cancelled_items, created_at, updated_at) VALUES ('op-1','test','cancelled',1,3,0,0,0,0,3,?,?)",
			[now, now],
		);
		for (const id of ["c1", "c2", "c3"]) {
			db.run(
				"INSERT INTO worker_jobs (id, worker_id, operation_id, data, status, run_at, created_at, updated_at) VALUES (?, 'w-1', 'op-1', '{}', 'cancelled', ?, ?, ?)",
				[id, now, now, now],
			);
		}
		db.run(
			"INSERT INTO worker_jobs (id, worker_id, operation_id, data, status, run_at, created_at, updated_at) VALUES ('p1', 'w-1', 'op-1', '{}', 'pending', ?, ?, ?)",
			[now, now, now],
		);

		expect(await workerJobRepository.countCancelledByOperation("op-1")).toBe(3);

		const firstPage = await workerJobRepository.findCancelledByOperation("op-1", 2);
		expect(firstPage.map((item) => item.id)).toEqual(["c1", "c2"]);
		const secondPage = await workerJobRepository.findCancelledByOperation("op-1", 2, firstPage.at(-1)?.id);
		expect(secondPage.map((item) => item.id)).toEqual(["c3"]);

		await workerOperationRepository.markResumed("op-1", 3);

		const resumedRow = db
			.query(
				"SELECT status, total_items AS total, cancelled_items AS cancelled, retention_until AS retention FROM worker_operations WHERE id = 'op-1'",
			)
			.get() as { status: string; total: number; cancelled: number; retention: number | null };
		expect(resumedRow).toEqual({ status: "pending", total: 3, cancelled: 0, retention: null });

		// Resume re-inserts with `countOperationTotals: false` — the pre-set total stays.
		await workerJobRepository.enqueueMany(
			[
				{
					id: "n1",
					workerId: "w-1",
					operationId: "op-1",
					data: "{}",
					priority: 0,
					maxAttempts: 3,
					backoffType: "exponential",
					backoffDelayMs: 1000,
					runAt: new Date(),
				},
			],
			{ countOperationTotals: false },
		);
		expect((db.query("SELECT total_items AS total FROM worker_operations WHERE id = 'op-1'").get() as { total: number }).total).toBe(3);

		// The default still increments the operation total.
		await workerJobRepository.enqueueMany([
			{
				id: "n2",
				workerId: "w-1",
				operationId: "op-1",
				data: "{}",
				priority: 0,
				maxAttempts: 3,
				backoffType: "exponential",
				backoffDelayMs: 1000,
				runAt: new Date(),
			},
		]);
		expect((db.query("SELECT total_items AS total FROM worker_operations WHERE id = 'op-1'").get() as { total: number }).total).toBe(4);
	});
});

describe("workerOperationRepository purge counts", () => {
	test("counts what a purge would delete, removes nothing, and the purge then deletes exactly that", async () => {
		const db = testDb.sqlite();
		const now = Math.floor(Date.now() / 1000);
		insertOperation(db, "op-done", "completed", null, now);
		insertOperation(db, "op-failed", "failed", null, now);
		insertOperation(db, "op-running", "running", null, now);
		const grouped: Array<{ id: string; operationId: string; status: string }> = [
			{ id: "job-1", operationId: "op-done", status: "completed" },
			{ id: "job-2", operationId: "op-done", status: "completed" },
			{ id: "job-3", operationId: "op-failed", status: "failed" },
		];
		for (const job of grouped) {
			db.run(
				"INSERT INTO worker_jobs (id, worker_id, operation_id, data, status, run_at, created_at, updated_at) VALUES (?, 'w-1', ?, '{}', ?, ?, ?, ?)",
				[job.id, job.operationId, job.status, now, now, now],
			);
		}

		await expect(workerOperationRepository.countTerminalOperations({ status: "all_terminal" })).resolves.toEqual({
			deletedOperationsCount: 2,
			deletedJobsCount: 3,
		});
		await expect(workerOperationRepository.countTerminalOperations({ status: "failed" })).resolves.toEqual({
			deletedOperationsCount: 1,
			deletedJobsCount: 1,
		});
		expect(existingIds(db)).toEqual(["op-done", "op-failed", "op-running"]);

		await expect(workerOperationRepository.purgeTerminalOperations({ status: "all_terminal" })).resolves.toEqual({
			deletedOperationsCount: 2,
			deletedJobsCount: 3,
		});
		expect(existingIds(db)).toEqual(["op-running"]);
	});
});

describe("workerOperationRepository retention", () => {
	test("expired retention never removes pending or running operations", async () => {
		const db = testDb.sqlite();
		const now = Math.floor(Date.now() / 1000);
		insertOperation(db, "terminal-expired", "completed", -86_400, now);
		insertOperation(db, "pending-stale", "pending", -86_400, now);
		insertOperation(db, "running-stale", "running", -86_400, now);
		insertOperation(db, "terminal-fresh", "completed", 86_400, now);

		const deleted = await workerOperationRepository.cleanupExpired(new Date(now * 1000));

		expect(deleted).toBe(1);
		expect(existingIds(db)).toEqual(["pending-stale", "running-stale", "terminal-fresh"]);
	});

	test("resuming an operation clears its retention deadline", async () => {
		const db = testDb.sqlite();
		const now = Math.floor(Date.now() / 1000);
		insertOperation(db, "resumed", "cancelled", -86_400, now);

		await workerOperationRepository.markResumed("resumed");

		const row = db.query("SELECT status, retention_until AS retentionUntil FROM worker_operations WHERE id = 'resumed'").get() as {
			status: string;
			retentionUntil: number | null;
		};
		expect(row.status).toBe("pending");
		expect(row.retentionUntil).toBeNull();

		// The daily cleanup must not delete the operation that just resumed.
		expect(await workerOperationRepository.cleanupExpired(new Date(now * 1000))).toBe(0);
		expect(existingIds(db)).toEqual(["resumed"]);
	});
});
