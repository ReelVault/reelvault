import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { imageMaintenanceService } from "@/modules/images/image-maintenance.service";
import { workerJobRepository } from "@/repositories/worker.repository";
import { workerOperationRepository } from "@/repositories/worker-operation.repository";
import { workerService } from "@/workers/worker.service";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { imageOptimizationWorker, processImageOptimizationTask, scanImagesForOptimizationTask } from "./image-optimization.worker";

// The scan queues real rows under a parent operation, so it needs the migrated test database.
useTestDatabase();

const activeStubs: Array<{ restore(): void }> = [];

beforeEach(() => {
	workerService.registry.register(imageOptimizationWorker);
});

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
	workerService.registry.unregister(imageOptimizationWorker.id);
});

describe("image optimization task", () => {
	test("hands the task's own abort signal to the optimizer and reports its outcome", async () => {
		let received: { imageId: string; signal: AbortSignal | undefined } | undefined;
		activeStubs.push(
			stubMethod(imageMaintenanceService, "optimizeImageById", (imageId: string, signal?: AbortSignal) => {
				received = { imageId, signal };

				return Promise.resolve("reoptimized");
			}),
		);
		const signal = AbortSignal.timeout(1000);

		const result = await processImageOptimizationTask({ imageId: "image-1" }, { signal });

		expect(result).toEqual({ imageId: "image-1", outcome: "reoptimized" });
		expect(received?.imageId).toBe("image-1");
		expect(received?.signal).toBe(signal);
	});

	test("converts optimization failures to domain errors", async () => {
		activeStubs.push(stubMethod(imageMaintenanceService, "optimizeImageById", () => Promise.reject(new Error("corrupt image"))));

		await expect(processImageOptimizationTask({ imageId: "image-2" })).rejects.toMatchObject({ code: "internal" });
	});

	test("queues one task per outdated image under the scan's operation and task", async () => {
		const operationId = "operation-1";
		const taskId = "task-1";
		await workerOperationRepository.create({ id: operationId, type: "image-optimization-all" });
		await workerJobRepository.enqueue({
			id: taskId,
			workerId: "image-optimization-all",
			operationId,
			data: "{}",
			priority: 0,
			maxAttempts: 1,
			backoffType: "fixed",
			backoffDelayMs: 1_000,
			runAt: new Date(),
		});
		activeStubs.push(stubMethod(imageMaintenanceService, "findOutdatedImageIds", () => Promise.resolve(["image-1", "image-2", "image-3"])));

		const result = await scanImagesForOptimizationTask({ operationId, taskId });

		expect(result).toEqual({ requested: 3, queued: 3 });
		const queued = (await workerJobRepository.findByOperation(operationId, 10)).filter(
			(item) => item.workerId === imageOptimizationWorker.id && item.dependsOnJobId === taskId,
		);
		expect(
			queued.map((item) => JSON.parse(item.data).imageId).toSorted((left: string, right: string) => left.localeCompare(right)),
		).toEqual(["image-1", "image-2", "image-3"]);
	});

	test("converts scan failures to domain errors", async () => {
		activeStubs.push(stubMethod(imageMaintenanceService, "findOutdatedImageIds", () => Promise.reject(new Error("database unavailable"))));

		await expect(scanImagesForOptimizationTask({})).rejects.toMatchObject({ code: "internal" });
	});
});
