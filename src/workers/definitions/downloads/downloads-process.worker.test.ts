import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { workerService } from "@/workers/worker.service";
import { useTestDatabase } from "../../../../tests/helpers/test-database.helper";
import { downloadsProcessWorker, enqueueDownloadsProcess } from "./downloads-process.worker";

// The queued job is written to the migrated test database and read back.
const db = useTestDatabase();

beforeEach(() => {
	workerService.registry.register(downloadsProcessWorker);
});

afterEach(() => {
	workerService.registry.unregister(downloadsProcessWorker.id);
});

describe("enqueueDownloadsProcess", () => {
	test("enqueuing the same download twice keeps one active job", async () => {
		await enqueueDownloadsProcess("download-abc");
		await enqueueDownloadsProcess("download-abc");

		const jobs = await db.client().select().from(schema.workerJobs);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			workerId: "downloads-process",
			status: "pending",
			priority: 0,
			dedupeKey: "download-abc",
			referenceType: "download",
			referenceId: "download-abc",
		});
	});
});
