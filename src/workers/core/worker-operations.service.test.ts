import { beforeEach, describe, expect, mock, test } from "bun:test";
import { workerOperationsService } from "./worker-operations.service";
import { setWorkerRuntime } from "./worker-runtime";
import { createMockWorkerRuntime } from "./worker-runtime.test-utils";

/** Simulated active-operation table: cancelling removes the row, like `requestCancel` does. */
const activeOperationIds = new Set<string>();
const cancelledIds: string[] = [];
/** Ids whose `findById` reports a terminal status, so `cancel` refuses to cancel them. */
let stuckIds = new Set<string>();

await mock.module("@/database/repositories/worker-operation.repository", () => ({
	workerOperationRepository: {
		list: (options: { status?: string; limit?: number }) => {
			const ids = [...activeOperationIds].slice(0, options.limit ?? 50);

			return Promise.resolve({ data: ids.map((id) => ({ id, status: "pending" })), total: activeOperationIds.size });
		},
		findById: (id: string) => {
			if (!activeOperationIds.has(id)) return Promise.resolve(undefined);

			return Promise.resolve({ id, status: stuckIds.has(id) ? "completed" : "pending" });
		},
		requestCancel: (id: string) => {
			cancelledIds.push(id);
			activeOperationIds.delete(id);

			return Promise.resolve();
		},
		remove: () => Promise.resolve(undefined),
	},
}));

await mock.module("@/database/repositories/worker.repository", () => ({
	workerJobRepository: {
		findRunningByOperation: async () => [],
		cancelRunning: async () => true,
		cancelPendingByOperation: async () => 0,
	},
}));

setWorkerRuntime(
	createMockWorkerRuntime({
		pool: { cancel: () => undefined },
	}),
);

beforeEach(() => {
	activeOperationIds.clear();
	cancelledIds.length = 0;
	stuckIds = new Set();
});

describe("worker operations cancelAll", () => {
	test("cancels every active operation, beyond the first 1000-row page", async () => {
		for (let index = 0; index < 2500; index++) activeOperationIds.add(`op-${index}`);

		const count = await workerOperationsService.cancelAll();

		expect(count).toBe(2500);
		expect(cancelledIds).toHaveLength(2500);
		expect(activeOperationIds.size).toBe(0);
	});

	test("stops instead of spinning when the remaining operations cannot be cancelled", async () => {
		activeOperationIds.add("op-stuck");
		stuckIds.add("op-stuck");

		const count = await workerOperationsService.cancelAll();

		expect(count).toBe(0);
	});
});
