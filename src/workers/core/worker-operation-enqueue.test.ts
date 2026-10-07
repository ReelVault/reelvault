import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const createdOperations: string[] = [];
const removedOperations: string[] = [];
const cancelledOperations: string[] = [];

await mock.module("./worker-operations.service", () => ({
	workerOperationsService: {
		create: () => {
			const id = `op-${createdOperations.length + 1}`;
			createdOperations.push(id);

			return Promise.resolve({ id });
		},
		remove: (id: string) => {
			removedOperations.push(id);

			return Promise.resolve();
		},
	},
}));

await mock.module("@/database/repositories/worker.repository", () => ({
	workerJobRepository: {
		cancelPendingByOperation: (operationId: string) => {
			cancelledOperations.push(operationId);

			return Promise.resolve(0);
		},
	},
}));

const { enqueueWithOperation } = await import("./worker-operation-enqueue");

// mock.module is process-global in Bun — drop the facades so later test files
// see the real modules again.
afterAll(() => {
	mock.restore();
});

beforeEach(() => {
	createdOperations.length = 0;
	removedOperations.length = 0;
	cancelledOperations.length = 0;
});

describe("enqueueWithOperation failure cleanup", () => {
	test("cancels partially inserted jobs and removes the created operation when the enqueue fails", async () => {
		const failure = new Error("batch insert failed midway");

		await expect(
			enqueueWithOperation({ type: "test-worker" }, () => {
				throw failure;
			}),
		).rejects.toThrow(failure);

		expect(createdOperations).toEqual(["op-1"]);
		expect(cancelledOperations).toEqual(["op-1"]);
		expect(removedOperations).toEqual(["op-1"]);
	});

	test("keeps a caller-supplied operation untouched when the enqueue fails", async () => {
		await expect(
			enqueueWithOperation(
				{ type: "test-worker" },
				() => {
					throw new Error("nope");
				},
				{ operationId: "op-supplied" },
			),
		).rejects.toThrow("nope");

		expect(createdOperations).toEqual([]);
		expect(cancelledOperations).toEqual([]);
		expect(removedOperations).toEqual([]);
	});

	test("does not cancel or remove anything when the enqueue succeeds", async () => {
		const result = await enqueueWithOperation({ type: "test-worker" }, (operationId) => Promise.resolve(`queued:${operationId}`));

		expect(result).toEqual({ operationId: "op-1", result: "queued:op-1" });
		expect(cancelledOperations).toEqual([]);
		expect(removedOperations).toEqual([]);
	});

	test("removes a fresh operation whose enqueue deduped onto another one", async () => {
		const result = await enqueueWithOperation({ type: "test-worker" }, () => Promise.resolve("winner-op"), {
			isAttached: (enqueuedOperationId, operationId) => enqueuedOperationId === operationId,
		});

		expect(result).toEqual({ operationId: "op-1", result: "winner-op" });
		expect(removedOperations).toEqual(["op-1"]);
		expect(cancelledOperations).toEqual([]);
	});

	test("keeps the fresh operation when the enqueue attached to it", async () => {
		await enqueueWithOperation({ type: "test-worker" }, (operationId) => Promise.resolve(operationId), {
			isAttached: (enqueuedOperationId, operationId) => enqueuedOperationId === operationId,
		});

		expect(removedOperations).toEqual([]);
	});
});
