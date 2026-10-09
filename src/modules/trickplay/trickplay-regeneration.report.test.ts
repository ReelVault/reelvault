import { describe, expect, test } from "bun:test";
import { summarizeRegenerationOutcomes } from "./trickplay-regeneration.report";

describe("summarizeRegenerationOutcomes", () => {
	test("separates generated files, budget and other skips, failures and unfinished jobs", () => {
		const report = summarizeRegenerationOutcomes("op-1", [
			{ status: "completed", skipped: null, count: 4 },
			{ status: "completed", skipped: "storage-budget", count: 3 },
			{ status: "completed", skipped: "no-duration", count: 1 },
			{ status: "failed", skipped: null, count: 2 },
			{ status: "cancelled", skipped: null, count: 1 },
			{ status: "pending", skipped: null, count: 2 },
			{ status: "running", skipped: null, count: 1 },
		]);

		expect(report).toEqual({
			operationId: "op-1",
			total: 14,
			generated: 4,
			skippedStorageBudget: 3,
			skippedOther: 1,
			failed: 2,
			cancelled: 1,
			unfinished: 3,
		});
	});

	test("an operation without jobs reports zeros", () => {
		expect(summarizeRegenerationOutcomes("op-empty", [])).toEqual({
			operationId: "op-empty",
			total: 0,
			generated: 0,
			skippedStorageBudget: 0,
			skippedOther: 0,
			failed: 0,
			cancelled: 0,
			unfinished: 0,
		});
	});
});
