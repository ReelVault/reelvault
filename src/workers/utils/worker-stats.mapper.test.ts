import { describe, expect, test } from "bun:test";
import { toJobContract, toOperationContract } from "@/workers/utils/worker-stats.mapper";

describe("worker operation contract mapping", () => {
	test("serializes operation timestamps as ISO strings and leaves out unset dates", () => {
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

		const contract = toOperationContract(operation);

		expect(contract).toMatchObject({
			id: "operation-1",
			startedAt: "2026-08-02T10:00:00.000Z",
			createdAt: "2026-08-02T10:00:00.000Z",
		});
		// completedAt is null on the row; the contract leaves the key out instead of sending null.
		expect(contract).not.toHaveProperty("completedAt");
	});
});

describe("worker item contract mapping", () => {
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

	test("exposes a stored prerequisite as the job's only dependency", () => {
		expect(toJobContract({ ...item, dependsOnJobId: "task-1" })).toMatchObject({
			id: "task-2",
			operationId: "operation-1",
			dependsOnTaskIds: ["task-1"],
		});
	});

	test("uses the supplied task ids when the row stores no prerequisite", () => {
		expect(toJobContract(item, ["task-0", "task-1"])).toMatchObject({ dependsOnTaskIds: ["task-0", "task-1"] });
	});
});
