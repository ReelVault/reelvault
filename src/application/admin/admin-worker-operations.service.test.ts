import { afterEach, describe, expect, test } from "bun:test";
import { adminAuditService } from "@/application/admin/admin-audit.service";
import { createMockWorkerItem } from "@/workers/core/worker-runtime.test-utils";
import { toJobContract } from "@/workers/utils/worker-stats.mapper";
import { workerService } from "@/workers/worker.service";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { adminWorkerOperationsService } from "./admin-worker-operations.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

describe("AdminWorkerOperationsService.retryItem", () => {
	test("refuses items that did not fail", async () => {
		const completed = toJobContract(createMockWorkerItem({ id: "job-done", status: "completed" }));
		stubs.push(stubMethod(workerService, "getItem", () => Promise.resolve(completed)));

		await expect(adminWorkerOperationsService.retryItem("job-done")).rejects.toMatchObject({ code: "worker.item_not_retryable" });
	});

	test("re-enqueues a failed item and audits the new job", async () => {
		const failed = toJobContract(createMockWorkerItem({ id: "job-failed", status: "failed" }));
		const retry = stubMethod(workerService, "retryItem", () => Promise.resolve(toJobContract(createMockWorkerItem({ id: "job-new" }))));
		stubs.push(
			stubMethod(workerService, "getItem", () => Promise.resolve(failed)),
			retry,
			stubMethod(adminAuditService, "record", () => Promise.resolve()),
		);

		expect(await adminWorkerOperationsService.retryItem("job-failed")).toEqual({ success: true, jobId: "job-new" });
		expect(retry.calls).toEqual([["job-failed"]]);
	});
});

describe("WorkerService.retryItem", () => {
	test("re-enqueues the stored payload with its dedupe key, reference and priority", async () => {
		const failed = createMockWorkerItem({
			id: "job-failed",
			workerId: "w-scan",
			status: "failed",
			data: '{"path":"/media"}',
			dedupeKey: "manual:w-scan",
			referenceType: "library",
			referenceId: "lib-1",
			priority: -10,
		});
		const enqueue = stubMethod(workerService.queue, "enqueue", () =>
			Promise.resolve(createMockWorkerItem({ id: "job-new", workerId: "w-scan" })),
		);
		stubs.push(
			stubMethod(workerService.queue, "getJob", () => Promise.resolve(failed)),
			enqueue,
		);

		const retried = await workerService.retryItem("job-failed");

		expect(retried?.id).toBe("job-new");
		expect(enqueue.calls).toEqual([
			["w-scan", { path: "/media" }, { dedupeKey: "manual:w-scan", reference: { type: "library", id: "lib-1" }, priority: -10 }],
		]);
	});
});
