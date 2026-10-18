import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { workerService } from "@/workers/worker.service";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { downloadsProcessWorker, enqueueDownloadsProcess } from "./downloads-process.worker";

useTestDatabase();

beforeEach(() => {
	workerService.registry.register(downloadsProcessWorker);
});

afterEach(() => {
	workerService.registry.unregister(downloadsProcessWorker.id);
});

describe("enqueueDownloadsProcess", () => {
	test("enqueuing the same download twice keeps one active job", async () => {
		const first = await enqueueDownloadsProcess("download-abc");
		const second = await enqueueDownloadsProcess("download-abc");

		expect(second.id).toBe(first.id);
		expect(await workerService.findActiveItem(downloadsProcessWorker.id, "download-abc")).toMatchObject({ id: first.id });
	});
});
