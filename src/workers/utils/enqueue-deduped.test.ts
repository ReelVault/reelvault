import { describe, expect, test } from "bun:test";
import { workerJobRepository } from "@/app/repositories/worker.repository";
import { workerOperationRepository } from "@/app/repositories/worker-operation.repository";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { enqueueDeduped } from "./enqueue-deduped.utils";

// Active-task checks and the tracked operation both read the migrated test database.
useTestDatabase();

const WORKER_ID = "library-scan";
const DEDUPE_KEY = "lib-1:all";

/** Seeds a pending job for the dedupe key under its own operation, as an earlier scan trigger left it. */
async function seedActiveScan(operationId: string): Promise<void> {
	await workerOperationRepository.create({ id: operationId, type: "library-scanning" });
	await workerJobRepository.enqueue({
		id: Bun.randomUUIDv7(),
		workerId: WORKER_ID,
		operationId,
		dedupeKey: DEDUPE_KEY,
		data: "{}",
		priority: 0,
		maxAttempts: 1,
		backoffType: "fixed",
		backoffDelayMs: 1_000,
		runAt: new Date(),
	});
}

describe("enqueueDeduped", () => {
	test("reports a dedupe hit through onDeduped and enqueues nothing", async () => {
		await seedActiveScan("op-active");
		const deduped: string[] = [];
		const enqueued: string[] = [];

		const result = await enqueueDeduped({
			targets: [{ workerId: WORKER_ID, dedupeKey: DEDUPE_KEY }],
			type: "library-scanning",
			reference: { type: "library", id: "lib-1" },
			label: "library scan",
			enqueue: (operationId) => {
				enqueued.push(operationId);

				return Promise.resolve({ operationId });
			},
			onDeduped: (operationId) => {
				deduped.push(operationId);
			},
		});

		expect(result).toEqual({ success: true, operationId: "op-active", status: "pending" });
		expect(deduped).toEqual(["op-active"]);
		expect(enqueued).toEqual([]);
	});

	test("opens a tracked operation and enqueues its task when no equivalent task is active", async () => {
		const deduped: string[] = [];

		const result = await enqueueDeduped({
			targets: [{ workerId: WORKER_ID, dedupeKey: DEDUPE_KEY }],
			type: "library-scanning",
			reference: { type: "library", id: "lib-1" },
			label: "library scan",
			enqueue: async (operationId) => {
				const job = await workerJobRepository.enqueue({
					id: Bun.randomUUIDv7(),
					workerId: WORKER_ID,
					operationId,
					dedupeKey: DEDUPE_KEY,
					data: "{}",
					priority: 0,
					maxAttempts: 1,
					backoffType: "fixed",
					backoffDelayMs: 1_000,
					runAt: new Date(),
				});

				return { operationId: job.operationId };
			},
			onDeduped: (operationId) => {
				deduped.push(operationId);
			},
		});

		expect(result.status).toBe("pending");
		expect(deduped).toEqual([]);
		expect(await workerOperationRepository.findById(result.operationId)).toMatchObject({
			type: "library-scanning",
			referenceId: "lib-1",
		});
		expect((await workerJobRepository.findByOperation(result.operationId, 5)).map((job) => job.dedupeKey)).toEqual([DEDUPE_KEY]);
	});
});
