import { describe, expect, test } from "bun:test";
import { type MediaFilesRefreshAllTaskDependencies, refreshAllMediaFilesTask } from "./media-files-refresh-all.worker";

describe("media-files-refresh-all worker", () => {
	test("queues technical and metadata refresh for all media files in batch", async () => {
		const scheduled: Array<{ mediaFileId: string; metadataId: string }> = [];
		const dependencies: MediaFilesRefreshAllTaskDependencies = {
			findAll: () =>
				Promise.resolve([
					{ id: "media-1", metadataId: "meta-1" },
					{ id: "media-2", metadataId: "meta-2" },
				]),
		};

		const result = await refreshAllMediaFilesTask(
			{ operationId: "op-1", taskId: "task-1" },
			(mediaFileId, metadataId) => {
				scheduled.push({ mediaFileId, metadataId });

				return Promise.resolve({ success: true });
			},
			dependencies,
		);

		expect(result).toEqual({ requested: 2, queued: 2 });
		expect(scheduled).toEqual([
			{ mediaFileId: "media-1", metadataId: "meta-1" },
			{ mediaFileId: "media-2", metadataId: "meta-2" },
		]);
	});
});
