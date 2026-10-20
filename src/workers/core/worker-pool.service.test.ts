import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk/common";
import { eq } from "drizzle-orm";
import { type WorkerItem, workerJobRepository } from "@/app/repositories/worker.repository";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { WorkerExecutionPoolService } from "./worker-pool.service";

// Jobs, schedule stats and admin notifications run against the migrated test database. Every job goes
// through the real claim, so the pool gets the runner, claim token and attempt count a production run gets.
// The job handlers are the one fake: they stand in for plugin code, and each test decides how its handler ends.
const db = useTestDatabase();
const WORKER_ID = "test-worker";
const RUNNER_ID = "test-runner";
const JOB_ID = "job-1";
const TIMEOUT_MESSAGE = "Execution timed out after 5ms";
const BACKOFF_DELAY_MS = 5000;

let pool: WorkerExecutionPoolService;

beforeEach(() => {
	pool = new WorkerExecutionPoolService();
	pool.setRunnerId(RUNNER_ID);
});

afterEach(async () => {
	await pool.drain();
});

/** A handler that settles only when its abort signal fires, rejecting with the abort reason. */
const abortableHandler: WorkerDefinition["handler"] = async ({ signal }) =>
	await new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason));
	});

function makeDefinition(handler: WorkerDefinition["handler"], timeoutMs = 1000): WorkerDefinition {
	return { id: WORKER_ID, timeoutMs, handler };
}

async function insertPendingJob(maxAttempts: number): Promise<void> {
	await db
		.client()
		.insert(schema.workerJobs)
		.values({
			id: JOB_ID,
			workerId: WORKER_ID,
			data: "{}",
			status: "pending",
			runAt: new Date(Date.now() - 60_000),
			maxAttempts,
			backoffType: "exponential",
			backoffDelayMs: BACKOFF_DELAY_MS,
		});
}

/** Claims the pending job the way the poller does, so the pool receives the row a production run would. */
async function claimJob(): Promise<WorkerItem> {
	const [item] = await workerJobRepository.claimNextBatch(
		{ workerId: WORKER_ID, runnerId: RUNNER_ID, concurrency: 1, timeoutMs: 60_000, now: new Date() },
		1,
	);
	if (!item) throw new Error("Expected the pending job to be claimed");

	return item;
}

async function jobRow() {
	const [row] = await db.client().select().from(schema.workerJobs).where(eq(schema.workerJobs.id, JOB_ID));

	return row;
}

async function scheduleRow() {
	const [row] = await db.client().select().from(schema.workerSchedules).where(eq(schema.workerSchedules.workerId, WORKER_ID));

	return row;
}

async function seedAdmin(): Promise<void> {
	await db
		.client()
		.insert(schema.users)
		.values({ id: "admin-1", name: "Admin", email: "admin@example.com", emailVerified: true, role: "admin" });
}

/** The admin notice is written after the outcome, in a detached task. Waiting for it keeps that write inside the test. */
async function waitForNotifications() {
	for (let attempt = 0; attempt < 200; attempt++) {
		const rows = await db.client().select().from(schema.notifications);
		if (rows.length > 0) return rows;
		await Bun.sleep(5);
	}
	throw new Error("The admin notification never arrived");
}

describe("worker execution pool: outcomes", () => {
	test("completes a job, stores its result, records the run, and frees the slot", async () => {
		await insertPendingJob(3);
		let freed = 0;
		pool.onSlotFreed(() => {
			freed++;
		});

		pool.start(
			makeDefinition(() => ({ ok: true })),
			await claimJob(),
		);
		expect(pool.totalRunningCount).toBe(1);
		await pool.drain();

		expect(await jobRow()).toMatchObject({ status: "completed", result: '{"ok":true}' });
		expect(await scheduleRow()).toMatchObject({ lastStatus: "completed" });
		expect(pool.totalRunningCount).toBe(0);
		expect(freed).toBe(1);
	});

	test("retries a failed job after its backoff while attempts remain", async () => {
		await insertPendingJob(3);
		const item = await claimJob();
		const before = Date.now();

		pool.start(
			makeDefinition(() => {
				throw new Error("boom");
			}),
			item,
		);
		await pool.drain();

		const row = await jobRow();
		expect(row).toMatchObject({ status: "pending", error: "boom", attempts: 1 });
		// runAt is stored at whole-second precision, so the bound leaves a second of slack below the backoff.
		expect(row?.runAt.getTime()).toBeGreaterThanOrEqual(before + BACKOFF_DELAY_MS - 1000);
	});

	test("fails a job permanently, records the failed run, and notifies administrators once attempts are exhausted", async () => {
		await seedAdmin();
		await insertPendingJob(1);

		pool.start(
			makeDefinition(() => {
				throw new Error("boom");
			}),
			await claimJob(),
		);
		await pool.drain();

		expect(await jobRow()).toMatchObject({ status: "failed", error: "boom" });
		expect(await scheduleRow()).toMatchObject({ lastStatus: "failed", lastError: "boom" });
		expect(await waitForNotifications()).toMatchObject([
			{ userId: "admin-1", type: "worker_failed", data: { workerId: WORKER_ID, error: "boom" } },
		]);
	});
});

describe("worker execution pool: aborts and timeouts", () => {
	test("requeues a job for the next claim when its worker is rescued", async () => {
		await insertPendingJob(3);
		pool.start(makeDefinition(abortableHandler, 10_000), await claimJob());

		expect(pool.requeueAllForWorker(WORKER_ID)).toBe(1);
		await pool.drain();

		const row = await jobRow();
		expect(row).toMatchObject({ status: "pending" });
		expect(row?.error).toStartWith("Requeued by rescue");
		expect((await claimJob()).id).toBe(JOB_ID);
	});

	test("requeues a job for the next claim when the engine shuts down", async () => {
		await insertPendingJob(3);
		pool.start(makeDefinition(abortableHandler, 10_000), await claimJob());

		pool.cancelAll();
		await pool.drain();

		const row = await jobRow();
		expect(row).toMatchObject({ status: "pending" });
		expect(row?.error).toStartWith("Requeued by shutdown");
	});

	test("cancels a running job, records the cancelled run, and frees its slot", async () => {
		await insertPendingJob(3);
		pool.start(makeDefinition(abortableHandler, 10_000), await claimJob());

		expect(pool.cancel(JOB_ID)).toBe(true);
		await pool.drain();

		expect(await jobRow()).toMatchObject({ status: "cancelled" });
		expect(await scheduleRow()).toMatchObject({ lastStatus: "cancelled" });
		expect(pool.totalRunningCount).toBe(0);
	});

	// F7: a timeout is a failed attempt, not a user cancellation — retry while
	// attempts remain, never cancel the job.
	test("retries a timed-out job instead of cancelling it", async () => {
		await insertPendingJob(3);
		pool.start(makeDefinition(abortableHandler, 5), await claimJob());

		await pool.drain();

		expect(await jobRow()).toMatchObject({ status: "pending", error: TIMEOUT_MESSAGE });
	});

	test("fails a timed-out job permanently once attempts are exhausted, and notifies administrators", async () => {
		await seedAdmin();
		await insertPendingJob(1);
		pool.start(makeDefinition(abortableHandler, 5), await claimJob());

		await pool.drain();

		expect(await jobRow()).toMatchObject({ status: "failed", error: TIMEOUT_MESSAGE });
		expect(await waitForNotifications()).toMatchObject([{ data: { workerId: WORKER_ID, error: TIMEOUT_MESSAGE } }]);
	});
});

describe("worker execution pool: drain", () => {
	test("drain returns at its bound while a handler is still running, and waits for it afterwards", async () => {
		await insertPendingJob(3);
		pool.start(
			makeDefinition(async () => {
				await Bun.sleep(200);

				return { ok: true };
			}),
			await claimJob(),
		);

		await pool.drain(20);
		expect(pool.totalRunningCount).toBe(1);

		await pool.drain();
		expect(await jobRow()).toMatchObject({ status: "completed" });
	});
});
