import { describe, expect, test } from "bun:test";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { workerJobRepository } from "@/repositories/worker.repository";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { useTestDatabase } from "../helpers/test-database.helper";

// Migrated schema per test: the tables come from the real migrations, not hand-written DDL.
const db = useTestDatabase();

describe("worker operation read model: task transitions aggregate into the operation", () => {
	test("aggregates every task transition and cleans the retained group", async () => {
		await workerOperationRepository.create({ id: "operation-1", type: "test" });
		await enqueue("operation-1", "worker-a", "task-1");
		await enqueue("operation-1", "worker-a", "task-2", 3, ["task-1"]);

		expect((await workerOperationRepository.findById("operation-1"))?.status).toBe("pending");

		const firstClaim = await claimOne({
			workerId: "worker-a",
			runnerId: "runner-1",
			concurrency: 1,
			timeoutMs: 60_000,
			now: new Date(),
		});
		expect(firstClaim?.id).toBe("task-1");
		let operation = await workerOperationRepository.findById("operation-1");
		expect(operation).toMatchObject({ totalItems: 2, pendingItems: 1, runningItems: 1, status: "running" });
		expect(operation?.startedAt).toBeInstanceOf(Date);

		await workerJobRepository.retry("task-1", "runner-1", new Date(0), "retryable");
		operation = await workerOperationRepository.findById("operation-1");
		expect(operation).toMatchObject({ pendingItems: 2, runningItems: 0, completedItems: 0, status: "pending" });

		await claimOne({
			workerId: "worker-a",
			runnerId: "runner-1",
			concurrency: 1,
			timeoutMs: 60_000,
			now: new Date(),
		});
		await workerJobRepository.complete("task-1", "runner-1", JSON.stringify({ ok: true }));
		operation = await workerOperationRepository.findById("operation-1");
		expect(operation).toMatchObject({ pendingItems: 1, completedItems: 1, failedItems: 0, status: "pending" });
		expect(operation?.progressPercent).toBe(50);
		expect(operation?.completedAt).toBeNull();

		await claimOne({
			workerId: "worker-a",
			runnerId: "runner-1",
			concurrency: 1,
			timeoutMs: 60_000,
			now: new Date(),
		});
		await workerJobRepository.fail("task-2", "runner-1", "permanent");
		operation = await workerOperationRepository.findById("operation-1");
		expect(operation).toMatchObject({
			pendingItems: 0,
			runningItems: 0,
			completedItems: 1,
			failedItems: 1,
			status: "failed",
			progressPercent: 100,
		});
		expect(operation?.error).toBeNull();
		expect(operation?.completedAt).toBeInstanceOf(Date);

		const finalized = await workerOperationRepository.finalizeTerminalOperations(new Date("2026-08-07T12:00:00.000Z"));
		expect(finalized).toBe(1);
		operation = await workerOperationRepository.findById("operation-1");
		expect(operation?.retentionUntil).toEqual(new Date("2026-08-14T12:00:00.000Z"));
		expect((await workerOperationRepository.list({ status: "failed", limit: 10, offset: 0 })).total).toBe(1);

		await workerOperationRepository.cleanupExpired(new Date("2026-08-15T12:00:00.000Z"));
		expect(await workerOperationRepository.findById("operation-1")).toBeUndefined();
		expect(await workerJobRepository.findItem("task-1")).toBeUndefined();
		expect(await workerJobRepository.findItem("task-2")).toBeUndefined();
		expect(await db.client().select().from(schema.workerJobs)).toEqual([]);
	});
});

describe("worker operation read model: cancelled status, empty operations and retention", () => {
	test("derives cancelled status and recovers an expired lease without counters", async () => {
		await workerOperationRepository.create({ id: "operation-2", type: "test" });
		await enqueue("operation-2", "worker-b", "task-3", 1);
		await enqueue("operation-2", "worker-b", "task-4");

		await claimOne({
			workerId: "worker-b",
			runnerId: "runner-2",
			concurrency: 1,
			timeoutMs: 1,
			now: new Date("2026-08-07T12:00:00.000Z"),
		});
		await claimOne({
			workerId: "worker-b",
			runnerId: "runner-2",
			concurrency: 1,
			timeoutMs: 1,
			now: new Date("2026-08-07T12:00:01.000Z"),
		});

		const recovered = await workerOperationRepository.findById("operation-2");
		expect(recovered).toMatchObject({ failedItems: 1, runningItems: 1, status: "running" });

		await workerOperationRepository.create({ id: "operation-3", type: "test" });
		await enqueue("operation-3", "worker-c", "task-5");
		await workerJobRepository.cancelPending("task-5");
		const cancelled = await workerOperationRepository.findById("operation-3");
		expect(cancelled).toMatchObject({ totalItems: 1, cancelledItems: 1, status: "cancelled", progressPercent: 100 });
	});

	test("prioritizes controller errors and cancellation for empty operations", async () => {
		await workerOperationRepository.create({ id: "operation-error", type: "test", error: "controller failed" });
		await workerOperationRepository.create({ id: "operation-cancelled", type: "test" });
		await workerOperationRepository.requestCancel("operation-cancelled");

		expect(await workerOperationRepository.findById("operation-error")).toMatchObject({
			status: "failed",
			totalItems: 0,
			progressPercent: null,
		});
		expect(await workerOperationRepository.findById("operation-cancelled")).toMatchObject({ status: "cancelled", totalItems: 0 });
	});

	test("keeps grouped tasks out of per-worker retention trimming", async () => {
		await workerOperationRepository.create({ id: "operation-4", type: "test" });
		await enqueue("operation-4", "worker-d", "task-grouped");
		await claimAndComplete("worker-d", "task-grouped");

		await workerJobRepository.enqueue({
			id: "task-ungrouped",
			workerId: "worker-d",
			data: "{}",
			priority: 0,
			maxAttempts: 3,
			backoffType: "fixed",
			backoffDelayMs: 0,
			runAt: new Date(0),
		});
		await claimAndComplete("worker-d", "task-ungrouped");

		await workerJobRepository.trim("worker-d", "completed", 0);
		expect(await workerJobRepository.findItem("task-ungrouped")).toBeUndefined();
		expect(await workerJobRepository.findItem("task-grouped")).toMatchObject({ status: "completed" });
	});
});

describe("worker operation read model: dependency ordering", () => {
	test("does not claim a dependent task before its prerequisite completes", async () => {
		await workerOperationRepository.create({ id: "operation-sequence", type: "test" });
		await enqueue("operation-sequence", "worker-sequence", "task-prerequisite");
		await enqueue("operation-sequence", "worker-sequence", "task-dependent", 3, ["task-prerequisite"]);

		const prerequisite = await claimOne({
			workerId: "worker-sequence",
			runnerId: "runner-sequence",
			concurrency: 2,
			timeoutMs: 60_000,
			now: new Date(),
		});
		expect(prerequisite?.id).toBe("task-prerequisite");
		expect(
			await claimOne({
				workerId: "worker-sequence",
				runnerId: "runner-sequence",
				concurrency: 2,
				timeoutMs: 60_000,
				now: new Date(),
			}),
		).toBeUndefined();

		await workerJobRepository.complete("task-prerequisite", "runner-sequence", JSON.stringify({ ok: true }));
		const dependent = await claimOne({
			workerId: "worker-sequence",
			runnerId: "runner-sequence",
			concurrency: 2,
			timeoutMs: 60_000,
			now: new Date(),
		});
		expect(dependent?.id).toBe("task-dependent");
	});

	test("waits for every prerequisite in a dependency set", async () => {
		await workerOperationRepository.create({ id: "operation-multiple", type: "test" });
		await enqueue("operation-multiple", "worker-multiple", "task-prerequisite-a");
		await enqueue("operation-multiple", "worker-multiple", "task-prerequisite-b");
		await enqueue("operation-multiple", "worker-multiple", "task-dependent", 3, ["task-prerequisite-a", "task-prerequisite-b"]);

		await claimOne({
			workerId: "worker-multiple",
			runnerId: "runner-multiple",
			concurrency: 1,
			timeoutMs: 60_000,
			now: new Date(),
		});
		await workerJobRepository.complete("task-prerequisite-a", "runner-multiple", JSON.stringify({ ok: true }));
		await claimOne({
			workerId: "worker-multiple",
			runnerId: "runner-multiple",
			concurrency: 1,
			timeoutMs: 60_000,
			now: new Date(),
		});
		await workerJobRepository.complete("task-prerequisite-b", "runner-multiple", JSON.stringify({ ok: true }));

		const dependent = await claimOne({
			workerId: "worker-multiple",
			runnerId: "runner-multiple",
			concurrency: 1,
			timeoutMs: 60_000,
			now: new Date(),
		});
		expect(dependent?.id).toBe("task-dependent");
	});
});

describe("worker operation read model: dependency validation and stale claim tokens", () => {
	test("requires the same operation and rejects self and missing dependencies", async () => {
		await workerOperationRepository.create({ id: "operation-dependencies", type: "test" });
		await workerOperationRepository.create({ id: "operation-other", type: "test" });
		await enqueue("operation-dependencies", "worker-dependencies", "task-existing");

		await expect(
			workerJobRepository.enqueue({
				id: "task-ungrouped",
				workerId: "worker-dependencies",
				dependsOnTaskIds: ["task-existing"],
				data: "{}",
				priority: 0,
				maxAttempts: 3,
				backoffType: "fixed",
				backoffDelayMs: 0,
				runAt: new Date(0),
			}),
		).rejects.toMatchObject({ category: "validation" });
		await expect(enqueue("operation-other", "worker-dependencies", "task-cross-operation", 3, ["task-existing"])).rejects.toMatchObject({
			category: "validation",
		});
		await expect(enqueue("operation-dependencies", "worker-dependencies", "task-self", 3, ["task-self"])).rejects.toMatchObject({
			category: "conflict",
		});
		await expect(enqueue("operation-dependencies", "worker-dependencies", "task-missing", 3, ["does-not-exist"])).rejects.toMatchObject({
			category: "not_found",
		});
	});

	test("propagates failure and cancellation through dependent tasks", async () => {
		await workerOperationRepository.create({ id: "operation-failure", type: "test" });
		await enqueue("operation-failure", "worker-failure", "task-failure-root");
		await enqueue("operation-failure", "worker-failure", "task-failure-middle", 3, ["task-failure-root"]);
		await enqueue("operation-failure", "worker-failure", "task-failure-leaf", 3, ["task-failure-middle"]);

		await claimOne({
			workerId: "worker-failure",
			runnerId: "runner-failure",
			concurrency: 1,
			timeoutMs: 60_000,
			now: new Date(),
		});
		await workerJobRepository.fail("task-failure-root", "runner-failure", "permanent failure");
		expect((await workerJobRepository.findItem("task-failure-middle"))?.status).toBe("cancelled");
		expect((await workerJobRepository.findItem("task-failure-leaf"))?.status).toBe("cancelled");

		await workerOperationRepository.create({ id: "operation-cancel", type: "test" });
		await enqueue("operation-cancel", "worker-cancel", "task-cancel-root");
		await enqueue("operation-cancel", "worker-cancel", "task-cancel-dependent", 3, ["task-cancel-root"]);
		await workerJobRepository.cancelPending("task-cancel-root");
		expect((await workerJobRepository.findItem("task-cancel-dependent"))?.status).toBe("cancelled");
	});

	test("a stale claim token cannot mutate a row re-claimed by a newer run", async () => {
		await workerOperationRepository.create({ id: "operation-claim", type: "test" });
		await enqueue("operation-claim", "worker-claim", "task-claim");

		const first = await claimOne({
			workerId: "worker-claim",
			runnerId: "runner-claim",
			concurrency: 1,
			timeoutMs: 60_000,
			now: new Date(),
		});
		if (!first?.claimToken) throw new Error("Expected a claim token");

		expect(first.runnerId).toBe("runner-claim");

		// Simulate force-release/requeue followed by a newer claim of the same row.
		await workerJobRepository.requeueRunning("task-claim", "runner-claim", "rescue", first.claimToken);
		const second = await claimOne({
			workerId: "worker-claim",
			runnerId: "runner-claim",
			concurrency: 1,
			timeoutMs: 60_000,
			now: new Date(),
		});
		if (!second?.claimToken) throw new Error("Expected a claim token");

		expect(second.claimToken).not.toBe(first.claimToken);

		// A zombie holding the old token must not complete the new run.
		expect(await workerJobRepository.complete("task-claim", "runner-claim", JSON.stringify({ stale: true }), first.claimToken)).toBe(false);
		expect((await workerJobRepository.findItem("task-claim"))?.status).toBe("running");

		expect(await workerJobRepository.complete("task-claim", "runner-claim", JSON.stringify({ ok: true }), second.claimToken)).toBe(true);
		expect((await workerJobRepository.findItem("task-claim"))?.status).toBe("completed");
	});
});

async function enqueue(operationId: string, workerId: string, id: string, maxAttempts = 3, dependsOnTaskIds?: string[]) {
	return await workerJobRepository.enqueue({
		id,
		workerId,
		operationId,
		dependsOnTaskIds,
		data: "{}",
		priority: 0,
		maxAttempts,
		backoffType: "fixed",
		backoffDelayMs: 0,
		runAt: new Date(0),
	});
}

async function claimOne(input: Parameters<typeof workerJobRepository.claimNextBatch>[0]) {
	const [item] = await workerJobRepository.claimNextBatch(input, 1);

	return item;
}

async function claimAndComplete(workerId: string, taskId: string) {
	await claimOne({
		workerId,
		runnerId: `runner-${taskId}`,
		concurrency: 1,
		timeoutMs: 60_000,
		now: new Date(),
	});
	await workerJobRepository.complete(taskId, `runner-${taskId}`, JSON.stringify({ ok: true }));
}
