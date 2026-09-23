import { describe, expect, test } from "bun:test";
import { toJobContract, toOperationContract } from "@/workers/utils/worker-stats.mapper";

describe("worker operation contract mapping", () => {
	test("serializes operation dates and calculated metrics", () => {
		const createdAt = new Date("2026-08-02T10:00:00.000Z");
		const operation = {
			id: "operation-1",
			type: "library-scanning",
			referenceType: "library",
			referenceId: "library-1",
			status: "running" as const,
			cancelRequested: false,
			totalItems: 10,
			pendingItems: 6,
			runningItems: 2,
			completedItems: 2,
			failedItems: 0,
			cancelledItems: 0,
			progressPercent: 20,
			etaMs: 1_000,
			error: null,
			startedAt: createdAt,
			completedAt: null,
			retentionUntil: null,
			createdAt,
			updatedAt: createdAt,
		};

		expect(toOperationContract(operation)).toMatchObject({
			id: "operation-1",
			progressPercent: 20,
			etaMs: 1_000,
			startedAt: createdAt.toISOString(),
		});
	});
});

describe("worker item contract mapping", () => {
	test("exposes prerequisite task IDs for operation task groups", () => {
		const timestamp = new Date("2026-08-02T10:00:00.000Z");
		const item = {
			id: "task-2",
			workerId: "media-file-ingest",
			operationId: "operation-1",
			status: "pending" as const,
			priority: 0,
			attempts: 0,
			maxAttempts: 3,
			backoffType: "exponential" as const,
			backoffDelayMs: 1_000,
			dedupeKey: null,
			referenceType: null,
			referenceId: null,
			data: "{}",
			result: null,
			error: null,
			runAt: timestamp,
			leaseUntil: null,
			runnerId: null,
			claimToken: null,
			startedAt: null,
			completedAt: null,
			dependsOnJobId: null,
			progressPercent: null,
			createdAt: timestamp,
			updatedAt: timestamp,
		};

		expect(toJobContract(item, ["task-1"])).toMatchObject({
			id: "task-2",
			operationId: "operation-1",
			dependsOnTaskIds: ["task-1"],
		});
	});
});
