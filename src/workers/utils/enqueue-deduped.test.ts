import { afterEach, describe, expect, test } from "bun:test";
import { workerService } from "@/workers/worker.service";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { enqueueDeduped } from "./enqueue-deduped";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.toReversed()) stub.restore();

	activeStubs.length = 0;
});

describe("enqueueDeduped", () => {
	test("reports a dedupe hit through onDeduped without enqueueing a task", async () => {
		const deduped: string[] = [];
		const enqueued: string[] = [];
		activeStubs.push(stubMethod(workerService, "findActiveItem", () => Promise.resolve({ id: "job-1", operationId: "op-active" })));

		const result = await enqueueDeduped({
			targets: [{ workerId: "library-scan", dedupeKey: "lib-1:all" }],
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
});
