import { describe, expect, test } from "bun:test";
import { createMockWorkerItem } from "@/workers/core/worker-runtime.test-utils";
import { type MediaFileRefreshOperationDependencies, mediaFileRefreshService } from "./refresh-media-file.operation";

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

		await expect(mediaFileRefreshService.queue("media-1", { operationId: "operation-1" }, dependencies)).resolves.toMatchObject({
			technicalTask: { id: "technical-1" },
			metadataTask: { id: "metadata-1" },
		});
		expect(scheduled).toEqual([
			{ worker: "technical", options: { operationId: "operation-1" } },
			{ worker: "metadata", options: { operationId: "operation-1", dependsOnTaskIds: ["technical-1"] } },
		]);
	});
});
