import { describe, expect, test } from "bun:test";
import {
	type ImageOptimizationTaskDependencies,
	processImageOptimizationTask,
	scanImagesForOptimizationTask,
} from "./image-optimization.worker";

function dependencies(overrides: Partial<ImageOptimizationTaskDependencies> = {}): ImageOptimizationTaskDependencies {
	return {
		findOutdatedImageIds: async () => ["image-1", "image-2"],
		optimizeImageById: async (imageId) => (imageId === "image-1" ? "reoptimized" : "kept"),
		enqueue: async () => undefined,
		...overrides,
	};
}

describe("image optimization task", () => {
	test("optimizes a single image and reports the outcome", async () => {
		const optimized: string[] = [];
		const result = await processImageOptimizationTask(
			{ imageId: "image-1" },
			{ signal: AbortSignal.timeout(1000) },
			dependencies({
				optimizeImageById: (imageId, signal) => {
					expect(signal).toBeDefined();
					optimized.push(imageId);

					return Promise.resolve("reoptimized");
				},
			}),
		);

		expect(result).toEqual({ imageId: "image-1", outcome: "reoptimized" });
		expect(optimized).toEqual(["image-1"]);
	});

	test("requires an imageId", async () => {
		await expect(processImageOptimizationTask({ imageId: "" }, {}, dependencies())).rejects.toMatchObject({ code: "internal" });
	});

	test("converts optimization failures to domain errors", async () => {
		await expect(
			processImageOptimizationTask(
				{ imageId: "image-2" },
				{},
				dependencies({
					optimizeImageById: () => Promise.reject(new Error("corrupt image")),
				}),
			),
		).rejects.toMatchObject({ code: "internal" });
	});

	test("queues one task per outdated image with parent operation", async () => {
		const queued: Array<{ imageId: string; operationId?: string | undefined; dependsOnTaskIds?: string[] | undefined }> = [];
		const result = await scanImagesForOptimizationTask(
			{ operationId: "operation-1", taskId: "task-1" },
			dependencies({
				findOutdatedImageIds: async () => ["image-1", "image-2", "image-3"],
				enqueue: (data, options) => {
					queued.push({ imageId: data.imageId, operationId: options.operationId, dependsOnTaskIds: options.dependsOnTaskIds });

					return Promise.resolve(undefined);
				},
			}),
		);

		expect(result).toEqual({ requested: 3, queued: 3 });
		expect(queued.map((item) => item.imageId)).toEqual(["image-1", "image-2", "image-3"]);
		for (const item of queued) {
			expect(item.operationId).toBe("operation-1");
			expect(item.dependsOnTaskIds).toEqual(["task-1"]);
		}
	});

	test("converts scan failures to domain errors", async () => {
		await expect(
			scanImagesForOptimizationTask(
				{},
				dependencies({
					findOutdatedImageIds: () => Promise.reject(new Error("database unavailable")),
				}),
			),
		).rejects.toMatchObject({ code: "internal" });
	});
});
