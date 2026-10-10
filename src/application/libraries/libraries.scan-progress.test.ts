import { describe, expect, test } from "bun:test";
import { workerOperationRepository } from "@/database/repositories/worker-operation.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { librariesService } from "./libraries.service";

/** The library cards show one scan per library: its running scan when it has one, otherwise the queued one. */
describe("librariesService.getScanProgress", () => {
	test("lists each library once and shows its running scan in preference to a queued one", async () => {
		const restore = stubMethod(workerOperationRepository, "findActiveLibraryScans", () =>
			Promise.resolve([
				{ libraryId: "progress-library-a", status: "pending", progressPercent: null },
				{ libraryId: "progress-library-a", status: "running", progressPercent: 40 },
				{ libraryId: "progress-library-b", status: "pending", progressPercent: null },
			]),
		);
		try {
			expect(await librariesService.getScanProgress()).toEqual({
				data: [
					{ libraryId: "progress-library-a", status: "running", progressPercent: 40 },
					{ libraryId: "progress-library-b", status: "pending", progressPercent: null },
				],
			});
		} finally {
			restore.restore();
		}
	});
});
