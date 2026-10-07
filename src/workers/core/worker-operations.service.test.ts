import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerDefinition } from "@reelvault/sdk";
import type { WorkerItem } from "@/database/repositories/worker.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { workerOperationsService } from "./worker-operations.service";
import { setWorkerRuntime } from "./worker-runtime";
import { createMockWorkerItem, createMockWorkerRuntime } from "./worker-runtime.test-utils";

/** Simulated active-operation table: cancelling removes the row, like `requestCancel` does. */
const activeOperationIds = new Set<string>();
const cancelledIds: string[] = [];
/** Ids whose `findById` reports a terminal status, so `cancel` refuses to cancel them. */
let stuckIds = new Set<string>();
/** One resumable (cancelled) operation for the resume tests. */
let resumableOperation: { id: string; status: string } | undefined;
const cancelledJobs: WorkerItem[] = [];
const resumedCalls: Array<{ id: string; total: number }> = [];
const enqueueCalls: Array<{ workerId: string; count: number; countOperationTotals: boolean | undefined }> = [];

const activeStubs: Array<{ restore(): void }> = [];

const minimalDefinition = { id: "w-1" } as unknown as WorkerDefinition;

setWorkerRuntime(
	createMockWorkerRuntime({
		pool: { cancel: () => undefined },
		registry: {
			get: (workerId: string) => (workerId === "w-1" ? minimalDefinition : undefined),
		},
		queue: {
			enqueueMany: (
				workerId: string,
				entries: Array<{ data: unknown; options?: unknown }>,
				options?: { countOperationTotals?: boolean },
			) => {
				enqueueCalls.push({ workerId, count: entries.length, countOperationTotals: options?.countOperationTotals });

				return Promise.resolve([]);
			},
		},
	}),
);

beforeEach(async () => {
	activeOperationIds.clear();
	cancelledIds.length = 0;
	stuckIds = new Set();
	resumableOperation = undefined;
	cancelledJobs.length = 0;
	resumedCalls.length = 0;
	enqueueCalls.length = 0;

	const { workerOperationRepository } = await import("@/database/repositories/worker-operation.repository");
	const { workerJobRepository } = await import("@/database/repositories/worker.repository");
	activeStubs.push(
		stubMethod(workerOperationRepository, "list", (options: { status?: string; limit?: number }) => {
			const ids = [...activeOperationIds].slice(0, options.limit ?? 50);

			return Promise.resolve({ data: ids.map((id) => ({ id, status: "pending" })), total: activeOperationIds.size });
		}),
		stubMethod(workerOperationRepository, "findById", (id: string) => {
			if (resumableOperation?.id === id) return Promise.resolve(resumableOperation);
			if (!activeOperationIds.has(id)) return Promise.resolve(undefined);

			return Promise.resolve({ id, status: stuckIds.has(id) ? "completed" : "pending" });
		}),
		stubMethod(workerOperationRepository, "markResumed", (id: string, total: number) => {
			resumedCalls.push({ id, total });
			resumableOperation = undefined;

			return Promise.resolve();
		}),
		stubMethod(workerOperationRepository, "requestCancel", (id: string) => {
			cancelledIds.push(id);
			activeOperationIds.delete(id);

			return Promise.resolve();
		}),
		stubMethod(workerOperationRepository, "remove", () => Promise.resolve(undefined)),
		stubMethod(workerJobRepository, "findRunningByOperation", async () => []),
		stubMethod(workerJobRepository, "cancelRunning", async () => true),
		stubMethod(workerJobRepository, "cancelPendingByOperation", async () => 0),
		stubMethod(workerJobRepository, "countCancelledByOperation", () => Promise.resolve(cancelledJobs.length)),
		stubMethod(workerJobRepository, "findCancelledByOperation", (_operationId: string, limit: number, afterId?: string) =>
			Promise.resolve(cancelledJobs.filter((item) => !afterId || item.id > afterId).slice(0, limit)),
		),
	);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
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

describe("worker operations resume", () => {
	test("resumes every cancelled page and pre-sets the operation total", async () => {
		resumableOperation = { id: "op-resume", status: "cancelled" };
		for (let index = 0; index < 6000; index++) {
			cancelledJobs.push(
				createMockWorkerItem({
					id: `c-${String(index).padStart(5, "0")}`,
					workerId: "w-1",
					operationId: "op-resume",
					status: "cancelled",
				}),
			);
		}

		const result = await workerOperationsService.resume("op-resume");

		expect(result).toEqual({ resumed: 6000 });
		// The total is set to the full count up front, and the inserts never count again.
		expect(resumedCalls).toEqual([{ id: "op-resume", total: 6000 }]);
		expect(enqueueCalls).toEqual([
			{ workerId: "w-1", count: 5000, countOperationTotals: false },
			{ workerId: "w-1", count: 1000, countOperationTotals: false },
		]);
	});

	test("refuses to resume an operation without cancelled jobs", async () => {
		resumableOperation = { id: "op-empty", status: "cancelled" };

		await expect(workerOperationsService.resume("op-empty")).rejects.toThrow("no cancelled tasks");
		expect(resumedCalls).toEqual([]);
	});
});
