import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk/common";
import { eq } from "drizzle-orm";
import { systemResourcesService } from "@/config/system-resources.service";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { workerJobRepository } from "@/repositories/worker.repository";
// The service singleton installs the production runtime at import; the test restores it afterwards.
import { workerService } from "@/workers/worker.service";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { setWorkerRuntime } from "./worker.runtime";
import { WorkerPollingService } from "./worker-polling.service";
import { createMockWorkerRuntime } from "./worker-runtime.helper";

// Pending, claimed and running jobs run against the migrated test database through the real claim.
// The worker pool is the one fake: it starts threads, so the fake records what would start and keeps the slot count.
const db = useTestDatabase();
const definition: WorkerDefinition = {
	id: "w-poll",
	handler: async () => undefined,
	concurrency: 2,
	timeoutMs: 60_000,
};
const secondDefinition: WorkerDefinition = { ...definition, id: "w-poll-2" };

const started: string[] = [];
const runningCounts = new Map<string, number>();
let totalRunning = 0;
let activeJobIds: string[] = [];
let activeJobIdReads = 0;
const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	setWorkerRuntime(
		createMockWorkerRuntime({
			registry: {
				get: (id: string) => {
					if (id === definition.id) return definition;
					if (id === secondDefinition.id) return secondDefinition;

					return undefined;
				},
			},
			pool: {
				get totalRunningCount() {
					return totalRunning;
				},
				runningCountFor: (workerId: string) => runningCounts.get(workerId) ?? 0,
				getActiveJobIds: () => {
					activeJobIdReads++;

					return [...activeJobIds];
				},
				start: (_definition, item) => {
					started.push(item.id);
					totalRunning += 1;
				},
			},
		}),
	);
	started.length = 0;
	runningCounts.clear();
	totalRunning = 0;
	activeJobIds = [];
	activeJobIdReads = 0;
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
	setWorkerRuntime({ registry: workerService.registry, pool: workerService.pool, queue: workerService.queue });
});

async function insertJob(id: string, workerId: string, overrides: Partial<typeof schema.workerJobs.$inferInsert> = {}): Promise<void> {
	await db
		.client()
		.insert(schema.workerJobs)
		.values({ id, workerId, data: "{}", status: "pending", runAt: new Date(Date.now() - 60_000), ...overrides });
}

async function jobRow(id: string) {
	const [row] = await db.client().select().from(schema.workerJobs).where(eq(schema.workerJobs.id, id));

	return row;
}

async function pollOnce(polling: WorkerPollingService): Promise<void> {
	polling.start();
	try {
		await polling.poll();
	} finally {
		polling.stop();
	}
}

/** Waits until `condition` holds, polling a bounded number of times so a poll that never runs fails loudly. */
async function until(condition: () => boolean, attempts = 200): Promise<void> {
	for (let attempt = 0; attempt < attempts && !condition(); attempt++) await Bun.sleep(5);
	if (!condition()) throw new Error("The expected poll never happened");
}

describe("WorkerPollingService.poll", () => {
	test("claims nothing while the global pool is saturated", async () => {
		totalRunning = systemResourcesService.getWorkerPoolMaxConcurrent();
		await insertJob("job-1", "w-poll");

		await pollOnce(new WorkerPollingService());

		expect(started).toEqual([]);
		expect((await jobRow("job-1"))?.status).toBe("pending");
	});

	test("claims at most the worker's concurrency, tags the claimed jobs with this runner, and leaves the rest pending", async () => {
		await insertJob("job-1", "w-poll", { runAt: new Date(Date.now() - 3000) });
		await insertJob("job-2", "w-poll", { runAt: new Date(Date.now() - 2000) });
		await insertJob("job-3", "w-poll", { runAt: new Date(Date.now() - 1000) });
		const polling = new WorkerPollingService();
		polling.setRunnerId("runner-1");

		await pollOnce(polling);

		expect(started).toEqual(["job-1", "job-2"]);
		expect(await jobRow("job-1")).toMatchObject({ status: "running", runnerId: "runner-1" });
		expect((await jobRow("job-3"))?.status).toBe("pending");
		// The lease runs for the worker's timeout from the claim.
		const leaseMs = ((await jobRow("job-1"))?.leaseUntil?.getTime() ?? 0) - Date.now();
		expect(leaseMs).toBeGreaterThan(55_000);
		expect(leaseMs).toBeLessThanOrEqual(60_000);
	});

	test("does not reclaim a job this process is still running, even when its lease has expired", async () => {
		await insertJob("job-live", "w-poll", {
			status: "running",
			runnerId: "runner-1",
			startedAt: new Date(Date.now() - 120_000),
			leaseUntil: new Date(Date.now() - 60_000),
		});
		await insertJob("job-free", "w-poll");
		activeJobIds = ["job-live"];

		await pollOnce(new WorkerPollingService());

		expect(started).toEqual(["job-free"]);
		expect((await jobRow("job-live"))?.status).toBe("running");
	});

	test("skips workers with no free slots and unregistered workers, leaving their jobs pending", async () => {
		runningCounts.set("w-poll", 2); // at its concurrency of 2, so no free slots
		await insertJob("job-busy", "w-poll");
		await insertJob("job-unknown", "w-unknown");

		await pollOnce(new WorkerPollingService());

		expect(started).toEqual([]);
		expect((await jobRow("job-busy"))?.status).toBe("pending");
		expect((await jobRow("job-unknown"))?.status).toBe("pending");
	});

	test("reads the active-job set once per poll, not once per worker", async () => {
		await insertJob("job-1", "w-poll");
		await insertJob("job-2", "w-poll-2");

		await pollOnce(new WorkerPollingService());

		expect(started.toSorted((a, b) => a.localeCompare(b))).toEqual(["job-1", "job-2"]);
		expect(activeJobIdReads).toBe(1);
	});

	test("stops claiming once the global pool fills up mid-poll", async () => {
		// One slot is left in the global pool, so only the first worker that claims gets it.
		totalRunning = systemResourcesService.getWorkerPoolMaxConcurrent() - 1;
		await insertJob("job-a1", "w-poll", { runAt: new Date(Date.now() - 3000) });
		await insertJob("job-a2", "w-poll", { runAt: new Date(Date.now() - 2000) });
		await insertJob("job-b1", "w-poll-2", { runAt: new Date(Date.now() - 1000) });

		await pollOnce(new WorkerPollingService());

		expect(started).toHaveLength(1);
		const pending = [await jobRow("job-a1"), await jobRow("job-a2"), await jobRow("job-b1")].filter((row) => row?.status === "pending");
		expect(pending).toHaveLength(2);
	});
});

describe("WorkerPollingService wake-up drain", () => {
	test("a job that arrives during an in-flight poll is picked up by a follow-up poll", async () => {
		let claims = 0;
		let releaseFirstPoll!: () => void;
		const firstPollHeld = new Promise<void>((resolve) => {
			releaseFirstPoll = resolve;
		});
		const realClaim = workerJobRepository.claimNextBatch.bind(workerJobRepository);
		activeStubs.push(
			stubMethod(workerJobRepository, "claimNextBatch", async (...args: Parameters<typeof realClaim>) => {
				claims++;
				const items = await realClaim(...args);
				// Hold only the first poll in flight, after its real claim has run.
				if (claims === 1) await firstPollHeld;

				return items;
			}),
		);
		await insertJob("job-1", "w-poll");
		const polling = new WorkerPollingService();
		polling.start();
		await until(() => claims === 1);

		await insertJob("job-2", "w-poll");
		polling.triggerPoll();
		releaseFirstPoll();

		// The regular poll only runs after the one-second interval, so a 200 ms window passes only if the drain ran.
		await until(() => started.length === 2, 40);
		expect(started).toEqual(["job-1", "job-2"]);
		polling.stop();
	});
});
