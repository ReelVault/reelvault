import { describe, expect, test } from "bun:test";
import { createMockWorkerItem } from "@/workers/core/worker-runtime.helper";
import { type MediaFileRefreshOperationDependencies, MediaFileRefreshService } from "./refresh-media-file.operation";

describe("media file refresh operation", () => {
	test("connects technical refresh to metadata refresh with a dependency", async () => {
		const scheduled: Array<{ worker: string; input: unknown; options: unknown }> = [];
		const dependencies: MediaFileRefreshOperationDependencies = {
			findById: () => Promise.resolve({ id: "media-1", metadataId: "metadata-1" }),
			findActive: () => Promise.resolve(undefined),
			scheduleTechnical: (mediaFileId, options) => {
				scheduled.push({ worker: "technical", input: mediaFileId, options });

				return Promise.resolve(createMockWorkerItem({ id: "technical-1", operationId: "operation-1" }));
			},
			scheduleMetadata: (data, options) => {
				scheduled.push({ worker: "metadata", input: data, options });

				return Promise.resolve(createMockWorkerItem({ id: "metadata-1", operationId: "operation-1" }));
			},
		};

		const service = new MediaFileRefreshService(dependencies);

		await expect(service.queue("media-1", { operationId: "operation-1" })).resolves.toMatchObject({
			technicalTask: { id: "technical-1" },
			metadataTask: { id: "metadata-1" },
		});
		expect(scheduled).toEqual([
			{ worker: "technical", input: "media-1", options: { operationId: "operation-1" } },
			{
				worker: "metadata",
				input: { metadataId: "metadata-1" },
				options: { operationId: "operation-1", dependsOnTaskIds: ["technical-1"] },
			},
		]);
	});

	test("reuses an active metadata refresh from another operation and still schedules the technical refresh", async () => {
		const scheduled: Array<{ worker: string; input: unknown; options: unknown }> = [];
		const dependencies: MediaFileRefreshOperationDependencies = {
			findById: () => Promise.resolve({ id: "media-1", metadataId: "metadata-1" }),
			// The metadata refresh is active under its metadata id only: a lookup with any other key finds nothing.
			findActive: (workerId, dedupeKey) =>
				workerId === "metadata-refresh" && dedupeKey === "metadata-1"
					? Promise.resolve(createMockWorkerItem({ id: "metadata-active", operationId: "other-operation" }))
					: Promise.resolve(undefined),
			scheduleTechnical: (mediaFileId, options) => {
				scheduled.push({ worker: "technical", input: mediaFileId, options });

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
		expect(scheduled).toEqual([{ worker: "technical", input: "media-1", options: { operationId: "operation-1" } }]);
	});
});
