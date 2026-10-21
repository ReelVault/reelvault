import { describe, expect, test } from "bun:test";
import { workerJobRepository } from "@/repositories/worker.repository";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { enqueueWithOperation } from "./worker-operation.service";
import { workerOperationsService } from "./worker-operations.service";

// Operations and jobs are written to the migrated test database; nothing here is stubbed.
useTestDatabase();

/** Inserts one pending job under the operation, as a batch enqueue does before it fails. */
function insertJob(operationId: string) {
	return workerJobRepository.enqueue({
		id: Bun.randomUUIDv7(),
		workerId: "w-enqueue",
		operationId,
		data: "{}",
		priority: 0,
		maxAttempts: 1,
		backoffType: "exponential",
		backoffDelayMs: 1_000,
		runAt: new Date(),
	});
}

describe("enqueueWithOperation failure cleanup", () => {
	test("cancels partially inserted jobs and removes the created operation when the enqueue fails", async () => {
		const failure = new Error("batch insert failed midway");
		let operationId = "";
		let jobId = "";

		await expect(
			enqueueWithOperation({ type: "test-worker" }, async (id) => {
				operationId = id;
				jobId = (await insertJob(id)).id;

				throw failure;
			}),
		).rejects.toBe(failure);

		expect(await workerOperationRepository.findById(operationId)).toBeUndefined();
		expect(await workerJobRepository.findItem(jobId)).toMatchObject({ status: "cancelled" });
	});

	test("keeps a caller-supplied operation and its jobs untouched when the enqueue fails", async () => {
		const failure = new Error("nope");
		const operation = await workerOperationsService.create({ type: "test-worker" });
		let jobId = "";

		await expect(
			enqueueWithOperation(
				{ type: "test-worker" },
				async (id) => {
					jobId = (await insertJob(id)).id;

					throw failure;
				},
				{ operationId: operation.id },
			),
		).rejects.toBe(failure);

		expect(await workerOperationRepository.findById(operation.id)).toBeDefined();
		expect(await workerJobRepository.findItem(jobId)).toMatchObject({ status: "pending" });
	});

	test("returns the enqueue result with its operation id and keeps the operation on success", async () => {
		const { operationId, result } = await enqueueWithOperation({ type: "test-worker" }, async (id) => {
			await insertJob(id);

			return `queued:${id}`;
		});

		expect(result).toBe(`queued:${operationId}`);
		expect(await workerOperationRepository.findById(operationId)).toBeDefined();
	});

	test("removes a fresh operation whose enqueue deduped onto another one", async () => {
		const winner = await workerOperationsService.create({ type: "test-worker" });

		const { operationId, result } = await enqueueWithOperation({ type: "test-worker" }, async () => winner.id, {
			isAttached: (result, operationId) => result === operationId,
		});

		expect(result).toBe(winner.id);
		expect(await workerOperationRepository.findById(operationId)).toBeUndefined();
		expect(await workerOperationRepository.findById(winner.id)).toBeDefined();
	});
});
