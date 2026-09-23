import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk/common";
import { v7 as uuidv7 } from "uuid";
import type { EnqueueWorkerItemInput } from "@/database/repositories/worker.repository";
import { workerOperationsService } from "./worker-operations.service";
import { WorkerQueueService } from "./worker-queue.service";
import { setWorkerRuntime } from "./worker-runtime";
import { createMockWorkerRuntime } from "./worker-runtime.test-utils";

const definition: WorkerDefinition = {
	id: "w-queue",
	handler: async () => undefined,
	attempts: 5,
	backoff: { type: "exponential", delayMs: 1_000 },
};

/** Replaces a method on the live singleton for one test, recording calls.
 * Works on real repositories AND on the minimal facades other test files
 * install with bun's process-global mock.module(...). */
function stubMethod<TArgs extends unknown[] = unknown[]>(
	target: object,
	method: string,
	impl: (...args: TArgs) => unknown,
): { calls: TArgs[]; restore(): void } {
	const original = Reflect.get(target, method);
	const calls: TArgs[] = [];
	const replacement = (...args: TArgs) => {
		calls.push(args);

		return impl(...args);
	};
	Reflect.set(target, method, replacement);

	return {
		calls,
		restore: () => {
			if (original === undefined) Reflect.deleteProperty(target, method);
			else Reflect.set(target, method, original);
		},
	};
}

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(async () => {
	setWorkerRuntime(
		createMockWorkerRuntime({
			registry: {
				get: (id: string) => (id === "w-queue" ? definition : undefined),
				has: (id: string) => id === "w-queue",
			},
		}),
	);

	// Resolved through the live registry at test time — never at module load.
	const { workerJobRepository } = await import("@/database/repositories/worker.repository");
	const repo = workerJobRepository;
	activeStubs.push(
		stubMethod(repo, "enqueue", (item: never) => Promise.resolve(item)),
		stubMethod(repo, "enqueueMany", (items: never) => Promise.resolve(items)),
		stubMethod(repo, "cancelPending", () => Promise.resolve(true)),
		stubMethod(repo, "cancelRunning", () => Promise.resolve(true)),
		stubMethod(repo, "cancelAllPending", () => Promise.resolve(0)),
		stubMethod(repo, "purgeTerminalJobs", () => Promise.resolve(0)),
		stubMethod(repo, "findItem", () => Promise.resolve(undefined)),
		stubMethod(workerOperationsService, "create", () => Promise.resolve({ id: uuidv7() })),
		stubMethod(workerOperationsService, "remove", () => Promise.resolve()),
	);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

describe("WorkerQueueService.enqueue", () => {
	test("rejects unregistered workers", () => {
		const queue = new WorkerQueueService();
		expect(queue.enqueue("nope", {})).rejects.toThrow('Worker "nope" is not registered');
	});

	test("applies definition defaults for attempts and backoff", async () => {
		const queue = new WorkerQueueService();
		const captured: EnqueueWorkerItemInput[] = [];
		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		const stub = stubMethod(workerJobRepository, "enqueue", (item: EnqueueWorkerItemInput) => {
			captured.push(item);

			return Promise.resolve(item);
		});

		await queue.enqueue("w-queue", { file: "a.mkv" }, { dedupeKey: "d1", operationId: "op-1" });
		stub.restore();

		const item = captured[0];
		if (!item) throw new Error("Expected captured item");

		expect(item.maxAttempts).toBe(5);
		expect(item.backoffType).toBe("exponential");
		expect(item.backoffDelayMs).toBe(1_000);
		expect(item.dedupeKey).toBe("d1");
		expect(item.operationId).toBe("op-1");
		expect(item.priority).toBe(0);
		expect(JSON.parse(item.data)).toEqual({ file: "a.mkv" });
	});

	test("options override the definition and floors kick in", async () => {
		const queue = new WorkerQueueService();
		const captured: EnqueueWorkerItemInput[] = [];
		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		const stub = stubMethod(workerJobRepository, "enqueue", (item: EnqueueWorkerItemInput) => {
			captured.push(item);

			return Promise.resolve(item);
		});

		await queue.enqueue("w-queue", null, {
			attempts: 0, // floors at 1
			backoff: { type: "fixed", delayMs: -5 }, // floors at 0
			delayMs: -100, // negative delay → runAt ≈ now
			priority: -10,
			dependsOnJobId: "job-9",
			reference: { type: "library", id: "lib-1" },
		});
		stub.restore();

		const item = captured[0];
		if (!item) throw new Error("Expected captured item");

		expect(item.maxAttempts).toBe(1);
		expect(item.backoffType).toBe("fixed");
		expect(item.backoffDelayMs).toBe(0);
		expect(item.priority).toBe(-10);
		expect(item.dependsOnJobId).toBe("job-9");
		expect(item.referenceType).toBe("library");
		expect(item.referenceId).toBe("lib-1");
		expect(item.data).toBe("null");
		expect(Date.now() - item.runAt.getTime()).toBeLessThan(5_000);
	});

	test("falls back to the definition defaultPriority, options still win", async () => {
		const prioritized: WorkerDefinition = { ...definition, defaultPriority: 100 };
		setWorkerRuntime(
			createMockWorkerRuntime({
				registry: {
					get: (id: string) => (id === "w-queue" ? prioritized : undefined),
					has: (id: string) => id === "w-queue",
				},
			}),
		);

		const queue = new WorkerQueueService();
		const captured: EnqueueWorkerItemInput[] = [];
		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		const stub = stubMethod(workerJobRepository, "enqueue", (item: EnqueueWorkerItemInput) => {
			captured.push(item);

			return Promise.resolve(item);
		});

		await queue.enqueue("w-queue", null, {});
		await queue.enqueue("w-queue", null, { priority: 5 });
		stub.restore();

		const [defaulted, explicit] = captured;
		if (!(defaulted && explicit)) throw new Error("Expected two captured items");

		expect(defaulted.priority).toBe(100);
		expect(explicit.priority).toBe(5);
	});

	test("dependsOnTaskIds falls back to the first task as the job dependency", async () => {
		const queue = new WorkerQueueService();
		const captured: EnqueueWorkerItemInput[] = [];
		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		const stub = stubMethod(workerJobRepository, "enqueue", (item: EnqueueWorkerItemInput) => {
			captured.push(item);

			return Promise.resolve(item);
		});

		await queue.enqueue("w-queue", {}, { dependsOnTaskIds: ["task-1", "task-2"] });
		stub.restore();

		const item = captured[0];
		if (!item) throw new Error("Expected captured item");

		expect(item.dependsOnJobId).toBe("task-1");
		expect(item.dependsOnTaskIds).toEqual(["task-1", "task-2"]);
	});

	test("removes the freshly created operation when the job dedupes to an existing one", async () => {
		const queue = new WorkerQueueService();
		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		// The repo returns the pre-existing active row (its own operation) on a dedupe.
		const enqueue = stubMethod(workerJobRepository, "enqueue", () => Promise.resolve({ id: "job-existing", operationId: "op-existing" }));
		const remove = stubMethod<[string]>(workerOperationsService, "remove", () => Promise.resolve());

		await queue.enqueue("w-queue", { data: 1 }, { dedupeKey: "d1" });
		enqueue.restore();
		const removed = remove.calls.map((call) => call[0]);
		remove.restore();

		expect(removed).toHaveLength(1);
		expect(typeof removed[0]).toBe("string");
	});

	test("keeps the operation when the job is actually inserted", async () => {
		const queue = new WorkerQueueService();
		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		const enqueue = stubMethod(workerJobRepository, "enqueue", (item: { operationId?: string }) =>
			Promise.resolve({ id: "job-new", operationId: item.operationId }),
		);
		const remove = stubMethod(workerOperationsService, "remove", () => Promise.resolve());

		await queue.enqueue("w-queue", { data: 1 });
		enqueue.restore();
		const removedCount = remove.calls.length;
		remove.restore();

		expect(removedCount).toBe(0);
	});

	test("enqueueMany builds one input per entry and skips empty batches", async () => {
		const queue = new WorkerQueueService();
		expect(await queue.enqueueMany("w-queue", [])).toEqual([]);

		let batchInputs: EnqueueWorkerItemInput[] = [];
		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		const stub = stubMethod(workerJobRepository, "enqueueMany", (items: EnqueueWorkerItemInput[]) => {
			batchInputs = items;

			return Promise.resolve(items);
		});

		await queue.enqueueMany("w-queue", [{ data: 1 }, { data: 2, options: { priority: 3 } }]);
		stub.restore();

		expect(batchInputs.length).toBe(2);
	});
});

describe("WorkerQueueService cancellation", () => {
	test("cancelJob routes pending items through cancelPending and nudges the poller", async () => {
		const queue = new WorkerQueueService();
		let nudges = 0;
		queue.onEnqueue(() => {
			nudges += 1;
		});

		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		const repo = workerJobRepository;
		const findItem = stubMethod(repo, "findItem", () => Promise.resolve({ id: "job-1", status: "pending" }));
		const cancel = stubMethod(repo, "cancelPending", (_jobId: string) => Promise.resolve(true));

		expect(await queue.cancelJob("job-1")).toBe(true);
		expect(cancel.calls[0]?.[0]).toBe("job-1");
		expect(nudges).toBe(1);
		findItem.restore();
		cancel.restore();
	});

	test("cancelJob routes running items through cancelRunning without nudging", async () => {
		const queue = new WorkerQueueService();
		let nudges = 0;
		queue.onEnqueue(() => {
			nudges += 1;
		});

		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		const repo = workerJobRepository;
		const findItem = stubMethod(repo, "findItem", () => Promise.resolve({ id: "job-1", status: "running" }));
		const cancel = stubMethod(repo, "cancelRunning", (_jobId: string) => Promise.resolve(true));

		expect(await queue.cancelJob("job-1")).toBe(true);
		expect(cancel.calls[0]?.[0]).toBe("job-1");
		expect(nudges).toBe(0);
		findItem.restore();
		cancel.restore();
	});

	test("cancelJob returns false for unknown and terminal jobs", async () => {
		const queue = new WorkerQueueService();
		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		const repo = workerJobRepository;
		const responses = [undefined, { id: "job-1", status: "completed" }];
		const findItem = stubMethod(repo, "findItem", () => Promise.resolve(responses.shift()));

		expect(await queue.cancelJob("missing")).toBe(false);
		expect(await queue.cancelJob("job-1")).toBe(false);
		findItem.restore();
	});

	test("cancelAllPending nudges the poller only when something was cancelled", async () => {
		const queue = new WorkerQueueService();
		let nudges = 0;
		queue.onEnqueue(() => {
			nudges += 1;
		});

		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		const repo = workerJobRepository;
		let cancelledCount = 3;
		const cancel = stubMethod(repo, "cancelAllPending", () => Promise.resolve(cancelledCount));

		expect(await queue.cancelAllPending("w-queue")).toBe(3);
		expect(nudges).toBe(1);

		cancelledCount = 0;
		await queue.cancelAllPending("w-queue");
		expect(nudges).toBe(1);
		cancel.restore();
	});
});

describe("WorkerQueueService.purgeHistory", () => {
	test("converts olderThanDays into a cutoff date and passes the status through", async () => {
		const queue = new WorkerQueueService();
		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		const purge = stubMethod(workerJobRepository, "purgeTerminalJobs", (_opts?: { status?: string; cutoffDate?: Date }) =>
			Promise.resolve(0),
		);

		await queue.purgeHistory({ status: "failed", olderThanDays: 7 });
		purge.restore();

		const options = purge.calls[0]?.[0];
		if (!options?.cutoffDate) throw new Error("Expected options with cutoffDate");

		expect(options.status).toBe("failed");
		expect(options.cutoffDate).toBeInstanceOf(Date);
		expect(Date.now() - options.cutoffDate.getTime()).toBeCloseTo(7 * 24 * 60 * 60 * 1000, -6);
	});

	test("no cutoff when olderThanDays is missing or non-positive", async () => {
		const queue = new WorkerQueueService();
		const { workerJobRepository } = await import("@/database/repositories/worker.repository");
		const purge = stubMethod(
			workerJobRepository,
			"purgeTerminalJobs",
			(_opts?: { status?: string | undefined; cutoffDate?: Date | undefined }) => Promise.resolve(0),
		);

		await queue.purgeHistory({ status: "completed", olderThanDays: 0 });
		await queue.purgeHistory();
		purge.restore();

		const first = purge.calls[0]?.[0];
		expect(first?.cutoffDate).toBeUndefined();
		expect(purge.calls[1]?.[0]).toEqual({ status: undefined, cutoffDate: undefined });
	});
});
