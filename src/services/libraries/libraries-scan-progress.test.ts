import { describe, expect, test } from "bun:test";
import { insertWorkerOperations } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { librariesService } from "./libraries.service";

const { client } = useTestDatabase();

describe("getScanProgress", () => {
	test("reports one scan per library, preferring a running scan over a queued one", async () => {
		// The query returns the newest scan first, so the queued scan is seen before the running one, which must replace it.
		await insertWorkerOperations(client(), [
			{
				id: "scan-running",
				type: "library-scanning",
				referenceType: "library",
				referenceId: "lib-1",
				status: "running",
				progressPercent: 40,
				createdAt: new Date(1_000_000),
			},
			{
				id: "scan-queued",
				type: "library-scanning",
				referenceType: "library",
				referenceId: "lib-1",
				status: "pending",
				createdAt: new Date(2_000_000),
			},
			{
				id: "scan-other",
				type: "library-scanning",
				referenceType: "library",
				referenceId: "lib-2",
				status: "pending",
				createdAt: new Date(3_000_000),
			},
		]);

		const progress = await librariesService.getScanProgress();

		expect(progress.data).toHaveLength(2);
		expect(progress.data).toContainEqual({ libraryId: "lib-1", status: "running", progressPercent: 40 });
		expect(progress.data).toContainEqual({ libraryId: "lib-2", status: "pending", progressPercent: null });
	});
});
