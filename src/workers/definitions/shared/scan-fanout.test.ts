import { describe, expect, test } from "bun:test";
import { type ScanFanoutInput, scanFanoutTask } from "./scan-fanout";

interface TestItem {
	imageId: string;
}

function baseInput(overrides: Partial<ScanFanoutInput<TestItem>> = {}): ScanFanoutInput<TestItem> {
	return {
		context: {},
		label: "Test items queued",
		findIds: () => Promise.resolve([]),
		toData: (imageId) => ({ imageId }),
		enqueue: () => Promise.resolve(undefined),
		...overrides,
	};
}

describe("scanFanoutTask", () => {
	test("enqueues one task per id through the per-item path", async () => {
		const enqueued: Array<{ data: TestItem; operationId?: string | undefined; dependsOnTaskIds?: string[] | undefined }> = [];
		const result = await scanFanoutTask(
			baseInput({
				context: { operationId: "operation-1", taskId: "task-1" },
				findIds: () => Promise.resolve(["id-1", "id-2", "id-3"]),
				enqueue: (data, options) => {
					enqueued.push({ data, operationId: options.operationId, dependsOnTaskIds: options.dependsOnTaskIds });

					return Promise.resolve(undefined);
				},
			}),
		);

		expect(result).toEqual({ requested: 3, queued: 3 });
		expect(enqueued.map((item) => item.data.imageId).toSorted()).toEqual(["id-1", "id-2", "id-3"]);
		for (const item of enqueued) {
			expect(item.operationId).toBe("operation-1");
			expect(item.dependsOnTaskIds).toEqual(["task-1"]);
		}
	});

	test("passes the scan signal to findIds", async () => {
		const controller = new AbortController();
		let received: AbortSignal | undefined;
		await scanFanoutTask(
			baseInput({
				context: { signal: controller.signal },
				findIds: (signal) => {
					received = signal;

					return Promise.resolve([]);
				},
			}),
		);

		expect(received).toBe(controller.signal);
	});

	test("prefers the batched path and maps ids to data objects", async () => {
		const batches: TestItem[][] = [];
		const perItem: string[] = [];
		const result = await scanFanoutTask(
			baseInput({
				findIds: () => Promise.resolve(["id-1", "id-2", "id-3"]),
				enqueue: (_data, _options) => {
					perItem.push("called");

					return Promise.resolve(undefined);
				},
				enqueueMany: (items) => {
					batches.push(items);

					return Promise.resolve(undefined);
				},
			}),
		);

		expect(result).toEqual({ requested: 3, queued: 3 });
		expect(batches).toEqual([[{ imageId: "id-1" }, { imageId: "id-2" }, { imageId: "id-3" }]]);
		expect(perItem).toEqual([]);
	});
});
