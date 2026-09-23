import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk/common";
import type { WorkerItem, workerJobRepository } from "@/database/repositories/worker.repository";
import { systemResourcesService } from "@/system/system-resources.service";
import { WorkerPollingService } from "./worker-polling.service";
import { setWorkerRuntime } from "./worker-runtime";
import { createMockWorkerItem, createMockWorkerRuntime } from "./worker-runtime.test-utils";

const definition: WorkerDefinition = {
	id: "w-poll",
	handler: async () => undefined,
	concurrency: 2,
	timeoutMs: 60_000,
};

const started: string[] = [];
const runningCounts = new Map<string, number>();
let totalRunning = 0;
let activeJobIds: string[] = [];

function installRuntime(): void {
	setWorkerRuntime(
		createMockWorkerRuntime({
			registry: {
				get: (id: string) => (id === "w-poll" ? definition : undefined),
			},
			pool: {
				get totalRunningCount() {
					return totalRunning;
				},
				runningCountFor: (workerId: string) => runningCounts.get(workerId) ?? 0,
				getActiveJobIds: () => [...activeJobIds],
				start: (_definition, item) => {
					started.push(item.id);
				},
			},
		}),
	);
}

/** Replaces a method on the live singleton for one test, recording calls.
 * Works on real repositories AND on the minimal facades other test files
 * install with bun's process-global mock.module(...). */
function stubMethod<TArgs extends unknown[]>(
	target: object,
	method: string,
	impl: (...args: TArgs) => unknown,
): { calls: TArgs[]; restore(): void } {
	const original = Reflect.get(target, method);
	const calls: TArgs[] = [];
	Reflect.set(target, method, (...args: TArgs) => {
		calls.push(args);

		return impl(...args);
	});

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
	installRuntime();
	started.length = 0;
	runningCounts.clear();
	totalRunning = 0;
	activeJobIds = [];

	const { workerJobRepository: repo } = await import("@/database/repositories/worker.repository");
	activeStubs.push(
		stubMethod(repo, "findPendingWorkerIds", () => Promise.resolve([])),
		stubMethod(repo, "claimNextBatch", () => Promise.resolve([])),
	);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

function job(id: string): WorkerItem {
	return createMockWorkerItem({ id, workerId: "w-poll", status: "pending" });
}

type ClaimArgs = Parameters<typeof workerJobRepository.claimNextBatch>;

async function withClaimStub(impl: (...args: ClaimArgs) => Promise<WorkerItem[]>): Promise<{ calls: ClaimArgs[]; restore(): void }> {
	const { workerJobRepository: repo } = await import("@/database/repositories/worker.repository");
	const stub = stubMethod(repo, "claimNextBatch", impl);
	activeStubs.push(stub);

	return stub;
}

describe("WorkerPollingService.poll", () => {
	test("skips claiming entirely when the global pool is saturated", async () => {
		totalRunning = systemResourcesService.getWorkerPoolMaxConcurrent();
		const { workerJobRepository: repo } = await import("@/database/repositories/worker.repository");
		const pending = stubMethod(repo, "findPendingWorkerIds", () => Promise.resolve(["w-poll"]));
		activeStubs.push(pending);

		const polling = new WorkerPollingService();
		Reflect.set(polling, "isRunning", true);
		await polling.poll();

		// The saturation guard returns before reading pending work.
		expect(pending.calls).toHaveLength(0);
		expect(started).toEqual([]);
	});

	test("claims a batch per worker with runner id, timeout and active-job exclusion", async () => {
		const { workerJobRepository: repo } = await import("@/database/repositories/worker.repository");
		stubMethod(repo, "findPendingWorkerIds", () => Promise.resolve(["w-poll"]));
		const claim = await withClaimStub(() => Promise.resolve([job("job-1"), job("job-2")]));
		activeJobIds = ["job-live"];

		const polling = new WorkerPollingService();
		polling.setRunnerId("runner-1");
		Reflect.set(polling, "isRunning", true);
		await polling.poll();

		expect(claim.calls).toHaveLength(1);
		const firstCall = claim.calls[0];
		expect(firstCall).toBeDefined();
		if (!firstCall) return;

		const [options, freeSlots] = firstCall;
		expect(options.workerId).toBe("w-poll");
		expect(options.runnerId).toBe("runner-1");
		expect(options.concurrency).toBe(2);
		expect(options.timeoutMs).toBe(60_000);
		expect(options.excludeActiveIds).toEqual(["job-live"]);
		// freeSlots = min(concurrency 2 - running 0, global max - running 0)
		expect(freeSlots).toBe(Math.min(2, systemResourcesService.getWorkerPoolMaxConcurrent()));
		expect(started).toEqual(["job-1", "job-2"]);
	});

	test("skips workers with no free slots and unknown worker ids", async () => {
		const { workerJobRepository: repo } = await import("@/database/repositories/worker.repository");
		stubMethod(repo, "findPendingWorkerIds", () => Promise.resolve(["w-unknown", "w-poll"]));
		runningCounts.set("w-poll", 2); // at its concurrency of 2 → no free slots
		const claim = await withClaimStub(() => Promise.resolve([]));

		const polling = new WorkerPollingService();
		Reflect.set(polling, "isRunning", true);
		await polling.poll();

		expect(claim.calls).toHaveLength(0);
		expect(started).toEqual([]);
	});

	test("a second claim is skipped once the global pool filled up mid-poll", async () => {
		const { workerJobRepository: repo } = await import("@/database/repositories/worker.repository");
		stubMethod(repo, "findPendingWorkerIds", () => Promise.resolve(["w-poll", "w-poll"]));
		const claim = await withClaimStub(() => {
			// Simulate the pool filling up after the first claim.
			totalRunning = systemResourcesService.getWorkerPoolMaxConcurrent();

			return Promise.resolve([]);
		});

		const polling = new WorkerPollingService();
		Reflect.set(polling, "isRunning", true);
		await polling.poll();

		expect(claim.calls).toHaveLength(1);
	});
});

describe("WorkerPollingService wake-up drain", () => {
	test("a trigger during an in-flight poll is drained instead of lost", async () => {
		const { workerJobRepository: repo } = await import("@/database/repositories/worker.repository");
		stubMethod(repo, "findPendingWorkerIds", () => Promise.resolve(["w-poll"]));
		let claims = 0;
		let releaseClaim!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseClaim = resolve;
		});
		const claim = await withClaimStub(() => {
			claims += 1;
			if (claims === 1) return gate.then(() => []);

			return Promise.resolve([]);
		});

		const polling = new WorkerPollingService();
		polling.start();
		// Wait for the first poll to enter the claim.
		await new Promise((resolve) => {
			setTimeout(resolve, 30);
		});
		expect(claims).toBe(1);

		// Enqueue-style trigger while the poll is still running — must set pollAgain.
		polling.triggerPoll();
		releaseClaim();

		// The drain triggers another poll after the in-flight one settles.
		await new Promise((resolve) => {
			setTimeout(resolve, 60);
		});
		expect(claims).toBeGreaterThanOrEqual(2);
		expect(claim.calls.length).toBeGreaterThanOrEqual(2);

		polling.stop();
	});

	test("triggerPoll before start() is a no-op and stop() halts the loop", () => {
		const polling = new WorkerPollingService();
		polling.triggerPoll(); // not running — nothing scheduled

		polling.start();
		expect(Reflect.get(polling, "isRunning")).toBe(true);

		polling.stop();
		expect(Reflect.get(polling, "isRunning")).toBe(false);
		expect(Reflect.get(polling, "pollTimer")).toBeUndefined();
		expect(Reflect.get(polling, "pollDebounceTimer")).toBeUndefined();

		polling.triggerPoll(); // stopped — ignored

		return Promise.resolve();
	});

	test("recoverFromStall clears the in-flight guard and triggers a fresh poll", async () => {
		const polling = new WorkerPollingService();
		polling.start();

		Reflect.set(polling, "isPolling", true); // simulate a wedged loop
		polling.recoverFromStall();
		expect(Reflect.get(polling, "isPolling")).toBe(false);

		// Give the debounced poll a chance to run; it must not throw.
		await new Promise((resolve) => {
			setTimeout(resolve, 30);
		});
		polling.stop();
	});
});
