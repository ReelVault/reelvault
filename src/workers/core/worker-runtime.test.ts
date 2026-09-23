import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getWorkerRuntime, setWorkerRuntime, type WorkerRuntime } from "./worker-runtime";
import { createMockWorkerRuntime } from "./worker-runtime.test-utils";

let currentRuntime: WorkerRuntime = createMockWorkerRuntime();

beforeEach(() => {
	currentRuntime = createMockWorkerRuntime();
	setWorkerRuntime(currentRuntime);
});

afterEach(() => {
	// The runtime handle is process-global: leave a valid one installed for
	// whichever test file runs next.
	currentRuntime = createMockWorkerRuntime({ queue: { cancelAllPending: () => Promise.resolve(0) } });
	setWorkerRuntime(currentRuntime);
});

describe("worker runtime holder", () => {
	test("hands the registered runtime back to core services", () => {
		expect(getWorkerRuntime()).toBe(currentRuntime);
	});

	test("replacing the runtime swaps the handle for every later reader", () => {
		const next = createMockWorkerRuntime();
		setWorkerRuntime(next);

		expect(getWorkerRuntime()).toBe(next);
		expect(getWorkerRuntime()).not.toBe(currentRuntime);
	});

	test("the runtime exposes registry, pool and queue subsystems", () => {
		const runtime = getWorkerRuntime();

		expect(typeof runtime.registry.get).toBe("function");
		expect(typeof runtime.registry.has).toBe("function");
		expect(typeof runtime.registry.getAll).toBe("function");
		expect(typeof runtime.pool.start).toBe("function");
		expect(typeof runtime.pool.runningCountFor).toBe("function");
		expect(typeof runtime.pool.getActiveJobIds).toBe("function");
		expect(typeof runtime.queue.enqueue).toBe("function");
		expect(typeof runtime.queue.enqueueMany).toBe("function");
		expect(typeof runtime.queue.findActive).toBe("function");
		expect(typeof runtime.queue.cancelAllPending).toBe("function");
	});
});
