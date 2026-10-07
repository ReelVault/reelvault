import { describe, expect, test } from "bun:test";
import type { MediaFilesRefreshAllTaskDependencies } from "./media-files-refresh-all.worker";
import { refreshAllMediaFilesTask } from "./media-files-refresh-all.worker";

describe("media-files-refresh-all worker", () => {
	test("queues technical and metadata refresh for all media files in batch", async () => {
		const batches: Array<Array<{ id: string; metadataId: string }>> = [];
		const dependencies: MediaFilesRefreshAllTaskDependencies = {
			scanAll: async (onPage) => {
				const rows = [
					{ id: "media-1", metadataId: "meta-1" },
					{ id: "media-2", metadataId: "meta-2" },
				];
				await onPage(rows);

				return rows.length;
			},
			enqueueBatch: (targets) => {
				batches.push([...targets]);

				return Promise.resolve();
			},
		};

		const result = await refreshAllMediaFilesTask({ operationId: "op-1", taskId: "task-1" }, dependencies);

		expect(result).toEqual({ requested: 2, queued: 2 });
		expect(batches).toEqual([
			[
				{ id: "media-1", metadataId: "meta-1" },
				{ id: "media-2", metadataId: "meta-2" },
			],
		]);
	});
});
