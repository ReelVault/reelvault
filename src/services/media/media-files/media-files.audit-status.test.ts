import { afterEach, describe, expect, test } from "bun:test";
import { workerJobRepository } from "@/repositories/worker.repository";
import { mediaService } from "@/services/media/media-files/media-files.service";
import { workerService } from "@/workers/worker.service";
import { stubMethod } from "../../../../tests/helpers/method-stub.helper";

const activeStubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of activeStubs.splice(0).toReversed()) stub.restore();
});

describe("mediaService.getAuditStatus", () => {
	test("serves a completed report from cache instead of re-reading and re-validating it", async () => {
		const operationId = `op-audit-${crypto.randomUUID()}`;
		const report = { totalFilesChecked: 12, suspectCount: 0, suspects: [] };
		let findByOperationCalls = 0;

		activeStubs.push(
			stubMethod(workerService, "getOperation", () =>
				Promise.resolve({ type: "media-files-audit", status: "completed", progressPercent: 100 }),
			),
			stubMethod(workerJobRepository, "findByOperation", () => {
				findByOperationCalls++;

				return Promise.resolve([{ result: JSON.stringify(report) }]);
			}),
		);

		const first = await mediaService.getAuditStatus(operationId);
		const second = await mediaService.getAuditStatus(operationId);

		expect(first.result).toEqual(report);
		expect(second.result).toEqual(report);
		// The second poll is served entirely from the validated-result cache.
		expect(findByOperationCalls).toBe(1);
	});
});
