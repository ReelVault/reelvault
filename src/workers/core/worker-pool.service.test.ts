import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk/common";
import type { WorkerItem } from "@/database/repositories/worker.repository";
import { WorkerExecutionPoolService } from "./worker-pool.service";

const completed: string[] = [];
const failed: string[] = [];
const retried: string[] = [];
const cancelled: string[] = [];
const requeued: string[] = [];

await mock.module("@/database/repositories/worker.repository", () => ({
	workerJobRepository: {
		updateProgress: () => undefined,
		complete: (id: string) => {
			completed.push(id);
		},
		fail: (id: string) => {
			failed.push(id);
		},
		retry: (id: string) => {
			retried.push(id);
		},
		cancelRunning: (id: string) => {
			cancelled.push(id);
		},
		requeueRunning: (id: string) => {
			requeued.push(id);
		},
	},
}));

await mock.module("@/database/repositories/worker-operation.repository", () => ({
	workerOperationRepository: { updateProgress: () => undefined },
}));

await mock.module("@/database/repositories/worker-schedules.repository", () => ({
	workerSchedulesRepository: { updateExecution: () => undefined },
}));

function makeItem(overrides: Partial<WorkerItem> = {}): WorkerItem {
	return {
		id: "job-1",
		workerId: "test-worker",
		operationId: null,
		dependsOnJobId: null,
		dedupeKey: null,
		referenceType: null,
		referenceId: null,
		data: "{}",
		status: "running",
		progressPercent: null,
		priority: 0,
		attempts: 0,
		maxAttempts: 3,
		backoffType: "exponential",
		backoffDelayMs: 1000,
		leaseUntil: null,
		runnerId: "default-runner",
		claimToken: "claim-1",
		result: null,
		error: null,
		startedAt: null,
		runAt: new Date(),
		completedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function makeDefinition(handler: WorkerDefinition["handler"], timeoutMs = 1000): WorkerDefinition {
	return { id: "test-worker", timeoutMs, handler };
}

let pool: WorkerExecutionPoolService;

beforeEach(() => {
	completed.length = 0;
	failed.length = 0;
	retried.length = 0;
	cancelled.length = 0;
	requeued.length = 0;
	pool = new WorkerExecutionPoolService();
	pool.setRunnerId("test-runner");
});

afterEach(async () => {
	await pool.drain();
});

describe("worker execution pool", () => {
	test("completes a job and frees the slot", async () => {
		let freed = 0;
		pool.onSlotFreed(() => {
			freed++;
		});

		pool.start(
			makeDefinition(() => ({ ok: true })),
			makeItem(),
		);
		expect(pool.totalRunningCount).toBe(1);

		await pool.drain();

		expect(completed).toEqual(["job-1"]);
		expect(pool.totalRunningCount).toBe(0);
		expect(freed).toBe(1);
	});

	test("schedules a retry while attempts remain", async () => {
		pool.start(
			makeDefinition(() => {
				throw new Error("boom");
			}),
			makeItem({ attempts: 0, maxAttempts: 3 }),
		);

		await pool.drain();

		expect(retried).toEqual(["job-1"]);
		expect(failed).toEqual([]);
		expect(pool.totalRunningCount).toBe(0);
	});

	test("fails permanently when attempts are exhausted", async () => {
		pool.start(
			makeDefinition(() => {
				throw new Error("boom");
			}),
			makeItem({ attempts: 3, maxAttempts: 3 }),
		);

		await pool.drain();

		expect(failed).toEqual(["job-1"]);
		expect(retried).toEqual([]);
	});

	test("requeues instead of cancelling when aborted by server rescue", async () => {
		pool.start(
			makeDefinition(
				async ({ signal }) =>
					await new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason));
					}),
				10_000,
			),
			makeItem(),
		);

		expect(pool.requeueAllForWorker("test-worker")).toBe(1);
		await pool.drain();

		expect(requeued).toEqual(["job-1"]);
		expect(cancelled).toEqual([]);
	});

	test("requeues instead of cancelling when the engine shuts down", async () => {
		pool.start(
			makeDefinition(
				async ({ signal }) =>
					await new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason));
					}),
				10_000,
			),
			makeItem(),
		);

		pool.cancelAll();
		await pool.drain();

		expect(requeued).toEqual(["job-1"]);
		expect(cancelled).toEqual([]);
	});

	test("cancel aborts a running job and reclaims its slot", async () => {
		pool.start(
			makeDefinition(
				async ({ signal }) =>
					await new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason));
					}),
				10_000,
			),
			makeItem(),
		);

		expect(pool.cancel("job-1")).toBe(true);
		await pool.drain();

		expect(cancelled).toEqual(["job-1"]);
		expect(pool.totalRunningCount).toBe(0);
	});

	// F7: a timeout is a failed attempt, not a user cancellation — retry while
	// attempts remain, never cancel the job.
	test("timeout schedules a retry instead of cancelling", async () => {
		pool.start(
			makeDefinition(
				async ({ signal }) =>
					await new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason));
					}),
				5,
			),
			makeItem({ attempts: 0, maxAttempts: 3 }),
		);

		await pool.drain();

		expect(retried).toEqual(["job-1"]);
		expect(cancelled).toEqual([]);
		expect(failed).toEqual([]);
	});

	test("timeout fails permanently when attempts are exhausted", async () => {
		pool.start(
			makeDefinition(
				async ({ signal }) =>
					await new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason));
					}),
				5,
			),
			makeItem({ attempts: 3, maxAttempts: 3 }),
		);

		await pool.drain();

		expect(failed).toEqual(["job-1"]);
		expect(cancelled).toEqual([]);
	});
});
