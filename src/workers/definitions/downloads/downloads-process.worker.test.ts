import { describe, expect, mock, test } from "bun:test";
import { downloadsProcessWorker, enqueueDownloadsProcess } from "./downloads-process.worker";

describe("downloadsProcessWorker", () => {
	test("defines the correct worker properties", () => {
		expect(downloadsProcessWorker.id).toBe("downloads-process");
		expect(typeof downloadsProcessWorker.handler).toBe("function");
	});

	test("enqueueDownloadsProcess delegates to workerService.addItem", async () => {
		const { createMockWorkerItem } = await import("@/workers/core/worker-runtime.test-utils");
		const { workerService } = await import("@/workers/worker.service");
		const originalAddItem = workerService.addItem;
		const calls: Array<{ workerId: string; data: unknown; options: unknown }> = [];

		workerService.addItem = mock((workerId, data, options) => {
			calls.push({ workerId, data, options });

			return Promise.resolve(createMockWorkerItem({ id: "job-123" }));
		});

		try {
			await enqueueDownloadsProcess("download-abc");
			expect(calls).toHaveLength(1);
			expect(calls[0]).toEqual({
				workerId: "downloads-process",
				data: { downloadId: "download-abc" },
				options: {
					dedupeKey: "download-abc",
					reference: { type: "download", id: "download-abc" },
				},
			});
		} finally {
			workerService.addItem = originalAddItem;
		}
	});
});
