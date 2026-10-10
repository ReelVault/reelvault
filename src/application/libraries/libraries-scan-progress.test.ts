import { afterEach, expect, test } from "bun:test";
import { workerOperationRepository } from "@/database/repositories/worker-operation.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { librariesService } from "./libraries.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

test("getScanProgress reports one scan per library, preferring a running scan over a queued one", async () => {
	stubs.push(
		stubMethod(workerOperationRepository, "findActiveLibraryScans", () =>
			Promise.resolve([
				{ libraryId: "lib-1", status: "pending", progressPercent: null },
				{ libraryId: "lib-1", status: "running", progressPercent: 40 },
				{ libraryId: "lib-2", status: "pending", progressPercent: null },
			]),
		),
	);

	expect(await librariesService.getScanProgress()).toEqual({
		data: [
			{ libraryId: "lib-1", status: "running", progressPercent: 40 },
			{ libraryId: "lib-2", status: "pending", progressPercent: null },
		],
	});
});

test("getScanProgress is empty when no library scan is queued or running", async () => {
	stubs.push(stubMethod(workerOperationRepository, "findActiveLibraryScans", () => Promise.resolve([])));

	expect(await librariesService.getScanProgress()).toEqual({ data: [] });
});
