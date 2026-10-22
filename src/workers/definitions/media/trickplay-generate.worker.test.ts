import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { getWorkerRuntime, setWorkerRuntime } from "@/workers/core/worker.runtime";
import { WorkerQueueService } from "@/workers/core/worker-queue.service";
import { createMockWorkerRuntime } from "@/workers/core/worker-runtime.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { enqueueTrickplayGenerationForLibrary, trickplayGenerateWorker } from "./trickplay-generate.worker";

// Operations and jobs run against the migrated test database through the real queue. The worker
// runtime's registry is the only fake: it decides which worker ids exist. The worker pool never runs anything.
const db = useTestDatabase();
const definition: WorkerDefinition = { id: trickplayGenerateWorker.id, handler: async () => undefined };
// The service singleton installs the production runtime at import; restore it so other files keep it.
const previousRuntime = getWorkerRuntime();

beforeEach(() => {
	setWorkerRuntime({
		...createMockWorkerRuntime({ registry: { get: (id: string) => (id === definition.id ? definition : undefined) } }),
		queue: new WorkerQueueService(),
	});
});

afterEach(() => {
	setWorkerRuntime(previousRuntime);
});

async function operationRows() {
	return await db.client().select().from(schema.workerOperations);
}

async function jobRows() {
	return await db.client().select().from(schema.workerJobs);
}

describe("enqueueTrickplayGenerationForLibrary", () => {
	test("opens a library operation and attaches the file's job to it", async () => {
		const item = await enqueueTrickplayGenerationForLibrary("mf-1", "library-a");

		const [operation] = await operationRows();
		expect(operation).toMatchObject({ type: "trickplay-generate", referenceType: "library", referenceId: "library-a" });
		if (!operation) throw new Error("Expected the enqueue to open an operation");
		expect(item.operationId).toBe(operation.id);
		expect(await jobRows()).toMatchObject([
			{
				workerId: "trickplay-generate",
				operationId: operation.id,
				dedupeKey: "mf-1",
				referenceType: "media-file",
				referenceId: "mf-1",
			},
		]);
	});

	test("attaches later files of the same library to the open operation", async () => {
		await enqueueTrickplayGenerationForLibrary("mf-2a", "library-b");
		const second = await enqueueTrickplayGenerationForLibrary("mf-2b", "library-b");

		const operations = await operationRows();
		expect(operations).toHaveLength(1);
		const [operation] = operations;
		if (!operation) throw new Error("Expected the enqueues to open an operation");
		expect(second.operationId).toBe(operation.id);
		expect((await jobRows()).map((job) => job.operationId)).toEqual([operation.id, operation.id]);
	});

	test("opens a new operation once the library's last one has finished", async () => {
		await db.client().insert(schema.workerOperations).values({
			id: "op-done",
			type: trickplayGenerateWorker.id,
			status: "completed",
			referenceType: "library",
			referenceId: "library-e",
		});

		const item = await enqueueTrickplayGenerationForLibrary("mf-5", "library-e");

		const fresh = (await operationRows()).find((row) => row.id === item.operationId);
		expect(item.operationId).not.toBe("op-done");
		expect(fresh).toMatchObject({ status: "pending", referenceType: "library", referenceId: "library-e" });
	});

	test("drops the fresh operation when the file's job already exists under another operation", async () => {
		await db.client().insert(schema.workerOperations).values({ id: "op-elsewhere", type: trickplayGenerateWorker.id });
		await db.client().insert(schema.workerJobs).values({
			id: "job-existing",
			workerId: trickplayGenerateWorker.id,
			operationId: "op-elsewhere",
			dedupeKey: "mf-3",
			data: "{}",
			status: "pending",
			runAt: new Date(),
		});

		const item = await enqueueTrickplayGenerationForLibrary("mf-3", "library-c");

		expect(item).toMatchObject({ id: "job-existing", operationId: "op-elsewhere" });
		expect((await operationRows()).map((row) => row.id)).toEqual(["op-elsewhere"]);
		expect(await jobRows()).toHaveLength(1);
	});

	test("files enqueued at the same time share one library operation", async () => {
		// Both calls start before either finishes its lookup. The per-library lock is what keeps them to one operation.
		const items = await Promise.all([
			enqueueTrickplayGenerationForLibrary("mf-6a", "library-d"),
			enqueueTrickplayGenerationForLibrary("mf-6b", "library-d"),
		]);

		const [operation] = await operationRows();
		if (!operation) throw new Error("Expected the enqueues to open an operation");
		expect(await operationRows()).toHaveLength(1);
		expect(items.map((item) => item.operationId)).toEqual([operation.id, operation.id]);
		expect(await jobRows()).toHaveLength(2);
	});

	test("removes the fresh operation and rethrows when the enqueue is refused", async () => {
		// With no registered worker the real queue refuses the job, and the operation it opened must not be left behind.
		setWorkerRuntime({ ...createMockWorkerRuntime({ registry: { get: () => undefined } }), queue: new WorkerQueueService() });

		await expect(enqueueTrickplayGenerationForLibrary("mf-7", "library-f")).rejects.toMatchObject({
			category: "not_found",
			code: "worker.not_found",
		});
		expect(await operationRows()).toEqual([]);
	});
});
