import { describe, expect, test } from "bun:test";
import { createMockWorkerItem } from "@/workers/core/worker-runtime.test-utils";
import { type MediaFileRefreshOperationDependencies, MediaFileRefreshService } from "./refresh-media-file.operation";

describe("media file refresh operation", () => {
	test("connects technical refresh to metadata refresh with a dependency", async () => {
		const scheduled: Array<{ worker: string; options: unknown }> = [];
		const dependencies: MediaFileRefreshOperationDependencies = {
			findById: () => Promise.resolve({ id: "media-1", metadataId: "metadata-1" }),
			findActive: () => Promise.resolve(undefined),
			scheduleTechnical: (_mediaFileId, options) => {
				scheduled.push({ worker: "technical", options });

				return Promise.resolve(createMockWorkerItem({ id: "technical-1", operationId: "operation-1" }));
			},
			scheduleMetadata: (_data, options) => {
				scheduled.push({ worker: "metadata", options });

				return Promise.resolve(createMockWorkerItem({ id: "metadata-1", operationId: "operation-1" }));
			},
		};

		const service = new MediaFileRefreshService(dependencies);

		await expect(service.queue("media-1", { operationId: "operation-1" })).resolves.toMatchObject({
			technicalTask: { id: "technical-1" },
			metadataTask: { id: "metadata-1" },
		});
		expect(scheduled).toEqual([
			{ worker: "technical", options: { operationId: "operation-1" } },
			{ worker: "metadata", options: { operationId: "operation-1", dependsOnTaskIds: ["technical-1"] } },
		]);
	});

	test("reuses an active metadata refresh from another operation instead of failing the technical refresh", async () => {
		const scheduled: Array<{ worker: string; options: unknown }> = [];
		const dependencies: MediaFileRefreshOperationDependencies = {
			findById: () => Promise.resolve({ id: "media-1", metadataId: "metadata-1" }),
			findActive: (workerId) =>
				workerId === "metadata-refresh"
					? Promise.resolve(createMockWorkerItem({ id: "metadata-active", operationId: "other-operation" }))
					: Promise.resolve(undefined),
			scheduleTechnical: (_mediaFileId, options) => {
				scheduled.push({ worker: "technical", options });

				return Promise.resolve(createMockWorkerItem({ id: "technical-1", operationId: "operation-1" }));
			},
			scheduleMetadata: () => {
				throw new Error("metadata refresh must not be scheduled twice");
			},
		};

		const service = new MediaFileRefreshService(dependencies);

		await expect(service.queue("media-1", { operationId: "operation-1" })).resolves.toMatchObject({
			technicalTask: { id: "technical-1" },
			metadataTask: { id: "metadata-active" },
		});
		expect(scheduled).toEqual([{ worker: "technical", options: { operationId: "operation-1" } }]);
	});
});
