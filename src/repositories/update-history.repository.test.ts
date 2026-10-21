import { describe, expect, test } from "bun:test";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { updateHistoryRepository } from "./update-history.repository";

useTestDatabase();

describe("UpdateHistoryRepository", () => {
	test("opens a run as running and closes it with its outcome", async () => {
		const id = await updateHistoryRepository.insert(
			{ action: "install", target: "server", fromVersion: "1.2.2", toVersion: "1.3.0", actorUserId: null },
			new Date("2026-10-09T10:00:00Z"),
		);
		expect(await updateHistoryRepository.findRunning()).toEqual([
			expect.objectContaining({ id, status: "running", toVersion: "1.3.0", finishedAt: null }),
		]);

		await updateHistoryRepository.finish(id, {
			status: "failed",
			errorMessage: "Checksum mismatch",
			finishedAt: new Date("2026-10-09T10:05:00Z"),
		});
		expect(await updateHistoryRepository.findRunning()).toEqual([]);

		const { data } = await updateHistoryRepository.findPage({ limit: 10, offset: 0 });
		expect(data).toEqual([expect.objectContaining({ id, status: "failed", errorMessage: "Checksum mismatch" })]);
	});

	test("pages runs newest first and counts every run in the total", async () => {
		await updateHistoryRepository.insert(
			{ action: "install", target: "web", fromVersion: null, toVersion: "1.0.0", actorUserId: null },
			new Date("2026-10-01T00:00:00Z"),
		);
		await updateHistoryRepository.insert(
			{ action: "rollback", target: "web", fromVersion: "1.1.0", toVersion: "1.0.0", actorUserId: null },
			new Date("2026-10-03T00:00:00Z"),
		);
		await updateHistoryRepository.insert(
			{ action: "install", target: "server", fromVersion: "1.2.0", toVersion: "1.3.0", actorUserId: null },
			new Date("2026-10-02T00:00:00Z"),
		);

		const firstPage = await updateHistoryRepository.findPage({ limit: 2, offset: 0 });
		expect(firstPage.total).toBe(3);
		expect(firstPage.data.map((run) => run.startedAt.toISOString())).toEqual(["2026-10-03T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]);

		const secondPage = await updateHistoryRepository.findPage({ limit: 2, offset: 2 });
		expect(secondPage.data.map((run) => run.startedAt.toISOString())).toEqual(["2026-10-01T00:00:00.000Z"]);
	});
});
