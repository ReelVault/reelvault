import { afterEach, describe, expect, test } from "bun:test";
import { updateHistoryRepository } from "@/database/repositories/update-history.repository";
import { stubMethod } from "../../../tests/helpers/method-stub";
import { updateHistoryService } from "./update-history.service";

const stubs: Array<{ restore(): void }> = [];

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.restore();
});

function runRow(overrides: { id: string; target?: "server" | "web"; toVersion?: string }) {
	return {
		id: overrides.id,
		actorUserId: null,
		action: "install" as const,
		target: overrides.target ?? ("server" as const),
		status: "running" as const,
		fromVersion: "1.2.2",
		toVersion: overrides.toVersion ?? "1.3.0",
		errorMessage: null,
		startedAt: new Date("2026-10-09T10:00:00Z"),
		finishedAt: null,
	};
}

describe("UpdateHistoryService.begin", () => {
	test("returns the id of the opened run", async () => {
		const insert = stubMethod(updateHistoryRepository, "insert", () => Promise.resolve("run-7"));
		stubs.push(insert);

		const id = await updateHistoryService.begin({
			action: "rollback",
			target: "server",
			fromVersion: "1.3.0",
			toVersion: "1.2.2",
			actorUserId: "admin-1",
		});

		expect(id).toBe("run-7");
		expect(insert.calls).toEqual([[expect.objectContaining({ action: "rollback", actorUserId: "admin-1" }), expect.any(Date)]]);
	});

	test("returns null instead of failing the update when the run cannot be written", async () => {
		stubs.push(stubMethod(updateHistoryRepository, "insert", () => Promise.reject(new Error("disk full"))));

		const id = await updateHistoryService.begin({
			action: "install",
			target: "web",
			fromVersion: null,
			toVersion: "1.0.0",
			actorUserId: null,
		});

		expect(id).toBeNull();
	});
});

describe("UpdateHistoryService outcomes", () => {
	test("skips the write when the run was never opened", async () => {
		const finish = stubMethod(updateHistoryRepository, "finish", () => Promise.resolve());
		stubs.push(finish);

		await updateHistoryService.succeed(null);

		expect(finish.calls).toEqual([]);
	});

	test("records the failure message of a run", async () => {
		const finish = stubMethod(updateHistoryRepository, "finish", () => Promise.resolve());
		stubs.push(finish);

		await updateHistoryService.fail("run-7", "Checksum mismatch");

		expect(finish.calls).toEqual([["run-7", expect.objectContaining({ status: "failed", errorMessage: "Checksum mismatch" })]]);
	});
});

describe("UpdateHistoryService.settleRunsAfterStart", () => {
	test("closes a server run as succeeded only when this process runs its target version", async () => {
		stubs.push(
			stubMethod(updateHistoryRepository, "findRunning", () =>
				Promise.resolve([runRow({ id: "installed" }), runRow({ id: "stale", toVersion: "1.2.2" }), runRow({ id: "web", target: "web" })]),
			),
		);
		const finish = stubMethod(updateHistoryRepository, "finish", () => Promise.resolve());
		stubs.push(finish);

		await updateHistoryService.settleRunsAfterStart("1.3.0");

		expect(finish.calls).toEqual([
			["installed", expect.objectContaining({ status: "succeeded", errorMessage: null })],
			["stale", expect.objectContaining({ status: "failed", errorMessage: "Interrupted before it finished" })],
			["web", expect.objectContaining({ status: "failed", errorMessage: "Interrupted before it finished" })],
		]);
	});
});

describe("UpdateHistoryService.list", () => {
	test("maps runs to ISO timestamps and reports the pagination", async () => {
		stubs.push(stubMethod(updateHistoryRepository, "findPage", () => Promise.resolve({ total: 1, data: [runRow({ id: "run-1" })] })));

		const page = await updateHistoryService.list({ page: 1, limit: 10 });

		expect(page).toMatchObject({
			total: 1,
			page: 1,
			data: [{ id: "run-1", startedAt: "2026-10-09T10:00:00.000Z", finishedAt: null, actorUserId: null }],
		});
	});
});
