import { describe, expect, test } from "bun:test";
import { insertWorkerJobs } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { adminWorkerOperationsService } from "./admin-worker-operations.service";

const { client } = useTestDatabase();

describe("AdminWorkerOperationsService.retryItem", () => {
	test("refuses items that did not fail", async () => {
		await insertWorkerJobs(client(), { id: "job-done", workerId: "library-scan", data: "{}", status: "completed", runAt: new Date() });

		await expect(adminWorkerOperationsService.retryItem("job-done")).rejects.toMatchObject({ code: "worker.item_not_retryable" });
	});
});
