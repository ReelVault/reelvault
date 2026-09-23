import { describe, expect, test } from "bun:test";
import { toReadModel } from "./worker-operation.repository";

describe("workerOperationRepository toReadModel", () => {
	test("calculates ETA accurately when startedAtMs is in UNIX epoch seconds (from raw SQLite aggregate)", () => {
		const now = Date.now();
		// 60 seconds ago represented as UNIX seconds (e.g. 1787000000)
		const startedAtSec = Math.floor((now - 60_000) / 1000);

		const row = {
			id: "op-test-1",
			type: "library-scanning",
			referenceType: "library",
			referenceId: "lib-1",
			cancelRequested: false,
			error: null,
			retentionUntil: null,
			createdAt: new Date(now - 60_000),
			updatedAt: new Date(),
			totalItems: 100,
			pendingItems: 40,
			runningItems: 5,
			completedItems: 60,
			failedItems: 0,
			cancelledItems: 0,
			startedAtMs: startedAtSec,
			completedAtMs: null,
		};

		const result = toReadModel(row);

		expect(result.startedAt).toBeInstanceOf(Date);
		// Epoch seconds (not ms) would land ~50 000 years out — the decoded
		// timestamp must sit at the expected wall-clock point (±5 s).
		expect(Math.abs((result.startedAt?.getTime() ?? 0) - (now - 60_000))).toBeLessThan(5_000);
		// 60 items done in ~60s = 1 item/s. 40 pending items = ~40,000 ms ETA (not 155 million minutes!).
		expect(result.etaMs).toBeGreaterThan(35_000);
		expect(result.etaMs).toBeLessThan(45_000);
	});

	test("returns 0 etaMs when pendingItems is 0", () => {
		const now = Date.now();
		const row = {
			id: "op-test-2",
			type: "library-scanning",
			referenceType: "library",
			referenceId: "lib-1",
			cancelRequested: false,
			error: null,
			retentionUntil: null,
			createdAt: new Date(now - 60_000),
			updatedAt: new Date(),
			totalItems: 100,
			pendingItems: 0,
			runningItems: 0,
			completedItems: 100,
			failedItems: 0,
			cancelledItems: 0,
			startedAtMs: Math.floor((now - 60_000) / 1000),
			completedAtMs: Math.floor(now / 1000),
		};

		const result = toReadModel(row);
		expect(result.etaMs).toBe(0);
		expect(result.status).toBe("completed");
	});
});
