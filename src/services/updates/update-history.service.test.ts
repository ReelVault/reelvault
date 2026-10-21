import { afterEach, describe, expect, test } from "bun:test";
import { updateHistoryRepository } from "@/repositories/update-history.repository";
import { type MethodStub, stubMethod } from "../../../tests/helpers/method-stub.helper";
import { selectUpdateHistory } from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { updateHistoryService } from "./update-history.service";

// Run rows are real rows. The only stub makes the insert fail, to reach the write-error path.
const db = useTestDatabase();
const stubs: MethodStub[] = [];

afterEach(() => {
	for (const stub of stubs.splice(0).toReversed()) stub.restore();
});

describe("UpdateHistoryService.begin", () => {
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

describe("UpdateHistoryService.settleRunsAfterStart", () => {
	test("closes a server run as succeeded only when this process runs its target version, and fails the rest", async () => {
		const installed = await updateHistoryService.begin({
			action: "install",
			target: "server",
			fromVersion: "1.2.2",
			toVersion: "1.3.0",
			actorUserId: null,
		});
		const stale = await updateHistoryService.begin({
			action: "install",
			target: "server",
			fromVersion: "1.2.1",
			toVersion: "1.2.2",
			actorUserId: null,
		});
		const web = await updateHistoryService.begin({
			action: "install",
			target: "web",
			fromVersion: "0.2.0",
			toVersion: "1.3.0",
			actorUserId: null,
		});

		await updateHistoryService.settleRunsAfterStart("1.3.0");

		const rows = await selectUpdateHistory(db.client());
		const byId = new Map(rows.map((row) => [row.id, row]));
		expect(byId.get(installed ?? "")).toMatchObject({ status: "succeeded", errorMessage: null });
		expect(byId.get(stale ?? "")).toMatchObject({ status: "failed", errorMessage: "Interrupted before it finished" });
		expect(byId.get(web ?? "")).toMatchObject({ status: "failed", errorMessage: "Interrupted before it finished" });
	});

	test("a failure while reading the open runs is logged and does not fail the startup", async () => {
		stubs.push(stubMethod(updateHistoryRepository, "findRunning", () => Promise.reject(new Error("database is locked"))));

		await expect(updateHistoryService.settleRunsAfterStart("1.3.0")).resolves.toBeUndefined();
	});
});
