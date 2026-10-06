import { afterEach, describe, expect, test } from "bun:test";
import { imageMaintenanceService } from "@/modules/images/image-maintenance.service";
import { workerService } from "@/workers/worker.service";
import { stubMethod } from "../../../../tests/helpers/method-stub";
import { processImageOptimizationTask, scanImagesForOptimizationTask } from "./image-optimization.worker";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0)) stub.restore();
});

describe("image optimization task", () => {
	test("optimizes a single image and reports the outcome", async () => {
		const optimized: string[] = [];
		activeStubs.push(
			stubMethod(imageMaintenanceService, "optimizeImageById", (imageId: string, signal?: AbortSignal) => {
				expect(signal).toBeDefined();
				optimized.push(imageId);

				return Promise.resolve("reoptimized");
			}),
		);

		const result = await processImageOptimizationTask({ imageId: "image-1" }, { signal: AbortSignal.timeout(1000) });

		expect(result).toEqual({ imageId: "image-1", outcome: "reoptimized" });
		expect(optimized).toEqual(["image-1"]);
	});

	test("requires an imageId", async () => {
		await expect(processImageOptimizationTask({ imageId: "" })).rejects.toMatchObject({ code: "internal" });
	});

	test("converts optimization failures to domain errors", async () => {
		activeStubs.push(stubMethod(imageMaintenanceService, "optimizeImageById", () => Promise.reject(new Error("corrupt image"))));

		await expect(processImageOptimizationTask({ imageId: "image-2" })).rejects.toMatchObject({ code: "internal" });
	});

	test("queues one task per outdated image with parent operation", async () => {
		const queued: Array<{ imageId: string; operationId?: string | undefined; dependsOnTaskIds?: string[] | undefined }> = [];
		activeStubs.push(
			stubMethod(imageMaintenanceService, "findOutdatedImageIds", () => Promise.resolve(["image-1", "image-2", "image-3"])),
			stubMethod(
				workerService,
				"addItems",
				(
					_workerId: string,
					entries: Array<{ data: { imageId: string }; options?: { operationId?: string; dependsOnTaskIds?: string[] } }>,
				) => {
					for (const entry of entries) {
						queued.push({
							imageId: entry.data.imageId,
							operationId: entry.options?.operationId,
							dependsOnTaskIds: entry.options?.dependsOnTaskIds,
						});
					}

					return Promise.resolve([]);
				},
			),
		);

		const result = await scanImagesForOptimizationTask({ operationId: "operation-1", taskId: "task-1" });

		expect(result).toEqual({ requested: 3, queued: 3 });
		expect(queued.map((item) => item.imageId)).toEqual(["image-1", "image-2", "image-3"]);
		for (const item of queued) {
			expect(item.operationId).toBe("operation-1");
			expect(item.dependsOnTaskIds).toEqual(["task-1"]);
		}
	});

	test("converts scan failures to domain errors", async () => {
		activeStubs.push(stubMethod(imageMaintenanceService, "findOutdatedImageIds", () => Promise.reject(new Error("database unavailable"))));

		await expect(scanImagesForOptimizationTask({})).rejects.toMatchObject({ code: "internal" });
	});
});
