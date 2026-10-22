import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk/common";
import { eq } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { workerJobRepository } from "@/repositories/worker.repository";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { setWorkerRuntime } from "./worker.runtime";
import { WorkerQueueService } from "./worker-queue.service";
import { createMockWorkerRuntime, restoreWorkerRuntime } from "./worker-runtime.helper";

// Jobs and operations are written to the migrated test database; the only fake is the
// worker runtime's registry, which says which worker ids exist and how they are configured.
const db = useTestDatabase();

const definition: WorkerDefinition = {
	id: "w-queue",
	handler: async () => undefined,
	attempts: 5,
	backoff: { type: "exponential", delayMs: 1_000 },
};

function registerDefinitions(definitions: WorkerDefinition[]): void {
	setWorkerRuntime(
		createMockWorkerRuntime({
			registry: {
				get: (id: string) => definitions.find((entry) => entry.id === id),
				has: (id: string) => definitions.some((entry) => entry.id === id),
			},
		}),
	);
}

beforeEach(() => {
	registerDefinitions([definition]);
});

afterEach(() => {
	restoreWorkerRuntime();
	setSystemTime();
});

/** Counts enqueue notifications: the poller is nudged on every enqueue and on pending cancels. */
function countNudges(queue: WorkerQueueService): () => number {
	let nudges = 0;
	queue.onEnqueue(() => {
		nudges += 1;
	});

	return () => nudges;
}

async function claimOne(workerId: string) {
	const [item] = await workerJobRepository.claimNextBatch(
		{ workerId, runnerId: `runner-${workerId}`, concurrency: 1, timeoutMs: 60_000, now: new Date() },
		1,
	);

	return item;
}

describe("WorkerQueueService.enqueue", () => {
	test("rejects unregistered workers without writing a row", async () => {
		const queue = new WorkerQueueService();

		await expect(queue.enqueue("nope", {})).rejects.toMatchObject({ category: "not_found", code: "worker.not_found" });
		expect(await db.client().select().from(schema.workerJobs)).toEqual([]);
	});

	test("stores the definition's attempts and backoff when the call sends none", async () => {
		const queue = new WorkerQueueService();

		const job = await queue.enqueue("w-queue", { file: "a.mkv" });

		expect(await workerJobRepository.findItem(job.id)).toMatchObject({
			maxAttempts: 5,
			backoffType: "exponential",
			backoffDelayMs: 1_000,
		});
	});

	test("stores the call's options over the definition, floors out-of-range values and keeps the reference", async () => {
		setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const queue = new WorkerQueueService();

		const job = await queue.enqueue("w-queue", null, {
			attempts: 0, // floors at 1
			backoff: { type: "fixed", delayMs: -5 }, // floors at 0
			delayMs: -5_000, // a negative delay runs at once
			priority: -10,
			reference: { type: "library", id: "lib-1" },
		});

		const stored = await workerJobRepository.findItem(job.id);
		expect(stored).toMatchObject({
			maxAttempts: 1,
			backoffType: "fixed",
			backoffDelayMs: 0,
			priority: -10,
			referenceType: "library",
			referenceId: "lib-1",
		});
		expect(stored?.runAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
	});
});

describe("WorkerQueueService.enqueue priority and dependencies", () => {
	test("uses the definition's default priority unless the call sets one", async () => {
		registerDefinitions([{ ...definition, defaultPriority: 100 }]);
		const queue = new WorkerQueueService();

		const defaulted = await queue.enqueue("w-queue", null, {});
		const explicit = await queue.enqueue("w-queue", null, { priority: 5 });

		expect(await workerJobRepository.findItem(defaulted.id)).toMatchObject({ priority: 100 });
		expect(await workerJobRepository.findItem(explicit.id)).toMatchObject({ priority: 5 });
	});

	test("keeps only the first of several dependency ids as the job's dependency", async () => {
		const queue = new WorkerQueueService();
		// Dependencies must live in the same operation, so both tasks share one.
		await workerOperationRepository.create({ id: "op-deps", type: "test" });
		const prerequisite = await queue.enqueue("w-queue", {}, { operationId: "op-deps" });
		const second = await queue.enqueue("w-queue", {}, { operationId: "op-deps" });

		const dependent = await queue.enqueue("w-queue", {}, { operationId: "op-deps", dependsOnTaskIds: [prerequisite.id, second.id] });

		expect(await workerJobRepository.findItem(dependent.id)).toMatchObject({ dependsOnJobId: prerequisite.id });
	});
});

describe("WorkerQueueService.enqueue dedupe and batches", () => {
	test("a job that dedupes to an existing active row does not leave its own operation behind", async () => {
		const queue = new WorkerQueueService();

		const first = await queue.enqueue("w-queue", { data: 1 }, { dedupeKey: "d1" });
		const second = await queue.enqueue("w-queue", { data: 1 }, { dedupeKey: "d1" });

		expect(second.id).toBe(first.id);
		expect(await db.client().select().from(schema.workerOperations)).toEqual([expect.objectContaining({ id: first.operationId })]);
	});

	test("enqueueMany stores one row per entry with its own priority, and an empty batch writes nothing", async () => {
		const queue = new WorkerQueueService();

		expect(await queue.enqueueMany("w-queue", [])).toEqual([]);
		expect(await db.client().select().from(schema.workerJobs)).toEqual([]);

		const batch = await queue.enqueueMany("w-queue", [{ data: 1 }, { data: 2, options: { priority: 3 } }]);

		const stored = await Promise.all(batch.map((item) => workerJobRepository.findItem(item.id)));
		expect(stored.map((item) => item?.priority).toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 3]);
	});
});

describe("WorkerQueueService cancellation", () => {
	test("cancelJob cancels a pending job and nudges the poller", async () => {
		const queue = new WorkerQueueService();
		const nudges = countNudges(queue);
		const job = await queue.enqueue("w-queue", {}, {});

		expect(await queue.cancelJob(job.id)).toBe(true);

		expect(await workerJobRepository.findItem(job.id)).toMatchObject({ status: "cancelled" });
		expect(nudges()).toBe(2); // one nudge from the enqueue, one from the cancel
	});

	test("cancelJob on a running job cancels it at once without nudging the poller", async () => {
		const queue = new WorkerQueueService();
		const job = await queue.enqueue("w-queue", {}, {});
		await claimOne("w-queue");
		const nudges = countNudges(queue);

		expect(await queue.cancelJob(job.id)).toBe(true);

		expect(await workerJobRepository.findItem(job.id)).toMatchObject({ status: "cancelled" });
		expect(nudges()).toBe(0);
	});

	test("cancelJob returns false for an unknown job and for a job that already completed", async () => {
		const queue = new WorkerQueueService();
		const job = await queue.enqueue("w-queue", {}, {});
		await claimOne("w-queue");
		await workerJobRepository.complete(job.id, "runner-w-queue", JSON.stringify({ ok: true }));

		expect(await queue.cancelJob("missing")).toBe(false);
		expect(await queue.cancelJob(job.id)).toBe(false);
		expect(await workerJobRepository.findItem(job.id)).toMatchObject({ status: "completed" });
	});

	test("cancelAllPending cancels every pending job of the worker and nudges only when something was cancelled", async () => {
		const queue = new WorkerQueueService();
		await queue.enqueue("w-queue", {}, {});
		await queue.enqueue("w-queue", {}, {});
		const nudges = countNudges(queue);

		expect(await queue.cancelAllPending("w-queue")).toBe(2);
		expect(nudges()).toBe(1);

		expect(await queue.cancelAllPending("w-queue")).toBe(0);
		expect(nudges()).toBe(1);
	});
});

describe("WorkerQueueService.purgeHistory", () => {
	/** Purge only touches standalone jobs (no operation), so the fixtures are enqueued without one. */
	async function standaloneJob(outcome: "completed" | "failed", createdDaysAgo: number): Promise<string> {
		const id = `standalone-${outcome}-${createdDaysAgo}-${Bun.randomUUIDv7()}`;
		await workerJobRepository.enqueue({
			id,
			workerId: `worker-${id}`,
			data: "{}",
			priority: 0,
			maxAttempts: 1,
			backoffType: "fixed",
			backoffDelayMs: 0,
			runAt: new Date(0),
		});
		const [claimed] = await workerJobRepository.claimNextBatch(
			{ workerId: `worker-${id}`, runnerId: `runner-${id}`, concurrency: 1, timeoutMs: 60_000, now: new Date() },
			1,
		);
		if (!claimed) throw new Error("Expected the fixture job to be claimable");
		if (outcome === "completed") await workerJobRepository.complete(id, `runner-${id}`, JSON.stringify({ ok: true }));
		else await workerJobRepository.fail(id, `runner-${id}`, "permanent");
		await db
			.client()
			.update(schema.workerJobs)
			.set({ createdAt: new Date(Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000) })
			.where(eq(schema.workerJobs.id, id));

		return id;
	}

	test("with dryRun it counts the matching jobs and deletes nothing", async () => {
		const queue = new WorkerQueueService();
		const jobId = await standaloneJob("completed", 1);

		expect(await queue.purgeHistory({ status: "completed", dryRun: true })).toBe(1);
		expect(await workerJobRepository.findItem(jobId)).toMatchObject({ status: "completed" });
	});

	test("olderThanDays removes only the jobs created before the cutoff", async () => {
		const queue = new WorkerQueueService();
		const oldJobId = await standaloneJob("completed", 10);
		const recentJobId = await standaloneJob("completed", 1);

		expect(await queue.purgeHistory({ status: "completed", olderThanDays: 7 })).toBe(1);

		expect(await workerJobRepository.findItem(oldJobId)).toBeUndefined();
		expect(await workerJobRepository.findItem(recentJobId)).toMatchObject({ status: "completed" });
	});

	test("the status filter leaves jobs with other terminal statuses in place", async () => {
		const queue = new WorkerQueueService();
		const failedJobId = await standaloneJob("failed", 10);
		const completedJobId = await standaloneJob("completed", 10);

		expect(await queue.purgeHistory({ status: "completed", olderThanDays: 7 })).toBe(1);

		expect(await workerJobRepository.findItem(completedJobId)).toBeUndefined();
		expect(await workerJobRepository.findItem(failedJobId)).toMatchObject({ status: "failed" });
	});

	test("without a positive olderThanDays every matching terminal job is removed", async () => {
		const queue = new WorkerQueueService();
		const oldJobId = await standaloneJob("completed", 10);
		const recentJobId = await standaloneJob("completed", 1);

		expect(await queue.purgeHistory({ status: "completed", olderThanDays: 0 })).toBe(2);

		expect(await workerJobRepository.findItem(oldJobId)).toBeUndefined();
		expect(await workerJobRepository.findItem(recentJobId)).toBeUndefined();
	});

	test("without options every terminal job is removed, failed and completed alike", async () => {
		const queue = new WorkerQueueService();
		const failedJobId = await standaloneJob("failed", 1);
		const completedJobId = await standaloneJob("completed", 1);

		expect(await queue.purgeHistory()).toBe(2);

		expect(await workerJobRepository.findItem(failedJobId)).toBeUndefined();
		expect(await workerJobRepository.findItem(completedJobId)).toBeUndefined();
	});
});
