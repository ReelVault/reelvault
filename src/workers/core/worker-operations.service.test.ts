import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk";
import { eq } from "drizzle-orm";
import { workerOperationRepository } from "@/app/repositories/worker-operation.repository";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { stubMethod } from "../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { setWorkerRuntime } from "./worker.runtime";
import { workerOperationsService } from "./worker-operations.service";
import { WorkerQueueService } from "./worker-queue.service";
import { createMockWorkerRuntime, restoreWorkerRuntime } from "./worker-runtime.helper";

// Operations, jobs and the resumed queue run against the migrated test database. The pool (running
// worker threads) stays a no-op. Stubbed: the operation list in the stuck-operation test only. A
// listed operation that cancel refuses is a race between two reads, which the real tables cannot
// produce on demand, so the stub feeds the loop that stale row.
const db = useTestDatabase();
const INSERT_CHUNK = 500;
const definition: WorkerDefinition = { id: "w-1", handler: async () => undefined };
const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	setWorkerRuntime({
		...createMockWorkerRuntime({ registry: { get: (id: string) => (id === "w-1" ? definition : undefined) } }),
		queue: new WorkerQueueService(),
	});
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
	restoreWorkerRuntime();
});

async function insertOperations(ids: string[], status: "pending" | "cancelled"): Promise<void> {
	for (let start = 0; start < ids.length; start += INSERT_CHUNK) {
		const rows = ids.slice(start, start + INSERT_CHUNK).map((id) => ({ id, type: "w-1", status }));
		await db.client().insert(schema.workerOperations).values(rows);
	}
}

async function insertCancelledJobs(operationId: string, count: number): Promise<void> {
	const rows = Array.from({ length: count }, (_, index) => ({
		id: `c-${String(index).padStart(5, "0")}`,
		workerId: "w-1",
		operationId,
		data: "{}",
		status: "cancelled" as const,
		runAt: new Date(),
	}));
	for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
		await db
			.client()
			.insert(schema.workerJobs)
			.values(rows.slice(start, start + INSERT_CHUNK));
	}
}

async function operationById(id: string) {
	const [operation] = await db.client().select().from(schema.workerOperations).where(eq(schema.workerOperations.id, id));

	return operation;
}

describe("worker operations cancelAll", () => {
	test("cancels every active operation, beyond the first 1000-row page", async () => {
		await insertOperations(
			Array.from({ length: 2500 }, (_, index) => `op-${index}`),
			"pending",
		);

		const count = await workerOperationsService.cancelAll();

		expect(count).toBe(2500);
		const rows = await db.client().select().from(schema.workerOperations);
		expect(rows.filter((row) => row.status !== "cancelled")).toEqual([]);
	});

	test("stops instead of spinning when the remaining operations cannot be cancelled", async () => {
		// The list reports an operation that no longer exists, so cancel refuses it and the loop must stop.
		activeStubs.push(
			// The stub yields to the event loop, so a loop that never stops fails on the test timeout instead of hanging the run.
			stubMethod(workerOperationRepository, "list", () =>
				Bun.sleep(0).then(() => ({ data: [{ id: "op-stuck", status: "pending" }], total: 1 })),
			),
		);

		expect(await workerOperationsService.cancelAll()).toBe(0);
	});
});

describe("worker operations resume", () => {
	test("resumes every cancelled page and pre-sets the operation total", async () => {
		await insertOperations(["op-resume"], "cancelled");
		await insertCancelledJobs("op-resume", 6000);

		const result = await workerOperationsService.resume("op-resume");

		expect(result).toEqual({ resumed: 6000 });
		// The total is set to the full count up front, and the re-enqueue inserts never count again.
		expect((await operationById("op-resume"))?.totalItems).toBe(6000);
		const pending = await db.client().select().from(schema.workerJobs).where(eq(schema.workerJobs.status, "pending"));
		expect(pending).toHaveLength(6000);
		expect(new Set(pending.map((job) => job.operationId))).toEqual(new Set(["op-resume"]));
	});

	test("refuses to resume an operation that is not cancelled", async () => {
		await insertOperations(["op-running"], "pending");

		await expect(workerOperationsService.resume("op-running")).rejects.toMatchObject({
			category: "validation",
			code: "worker.operation_not_cancelled",
		});
		expect((await operationById("op-running"))?.status).toBe("pending");
	});

	test("refuses to resume an operation without cancelled jobs", async () => {
		await insertOperations(["op-empty"], "cancelled");

		await expect(workerOperationsService.resume("op-empty")).rejects.toMatchObject({
			category: "validation",
			code: "worker.nothing_to_resume",
		});
		expect((await operationById("op-empty"))?.status).toBe("cancelled");
	});
});
