import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { databaseFactory } from "@/database/database";
import { isRecord } from "@/utils/type.utils";
import { workerJobRepository } from "./worker.repository";

// The ambient test database may or may not be migrated when this file runs
// (repository suites stub their own tables). The stub shape covers the real
// worker_jobs NOT-NULL columns without SQL defaults, so inserts work in both
// cases.
const sqlite = databaseFactory.sqlite;

beforeAll(() => {
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS worker_jobs (
			id TEXT PRIMARY KEY,
			worker_id TEXT NOT NULL,
			status TEXT NOT NULL,
			operation_id TEXT,
			depends_on_job_id TEXT,
			data TEXT NOT NULL DEFAULT '{}',
			run_at INTEGER,
			completed_at INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
});

beforeEach(() => {
	sqlite.run("DELETE FROM worker_jobs");
});

function insertJob(id: string, workerId: string, completedAt: number, options: { operationId?: string; status?: string } = {}): void {
	sqlite.run(
		"INSERT INTO worker_jobs (id, worker_id, status, operation_id, data, run_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?)",
		[id, workerId, options.status ?? "completed", options.operationId ?? null, completedAt, completedAt, completedAt, completedAt],
	);
}

function remainingIds(): string[] {
	return sqlite
		.query("SELECT id FROM worker_jobs ORDER BY id")
		.all()
		.map((row) => (isRecord(row) && typeof row.id === "string" ? row.id : ""));
}

describe("workerJobRepository.trimMany", () => {
	test("keeps the newest N standalone jobs per worker in one statement", async () => {
		for (let i = 1; i <= 4; i++) insertJob(`w1-c${i}`, "w-1", i);
		for (let i = 5; i <= 8; i++) insertJob(`w2-c${i}`, "w-2", i);
		insertJob("w3-c9", "w-3", 9);

		const changes = await workerJobRepository.trimMany(
			"completed",
			new Map([
				["w-1", 1],
				["w-2", 2],
				["w-3", 0],
			]),
		);

		expect(changes).toBe(6);
		expect(remainingIds()).toEqual(["w1-c4", "w2-c7", "w2-c8"]);
	});

	test("never trims operation-grouped jobs", async () => {
		insertJob("grouped", "w-1", 1, { operationId: "op-1" });
		insertJob("standalone", "w-1", 2);

		await workerJobRepository.trimMany("completed", new Map([["w-1", 0]]));

		expect(remainingIds()).toEqual(["grouped"]);
	});

	test("ignores other statuses and no-ops on an empty map", async () => {
		insertJob("failed-job", "w-1", 1, { status: "failed" });
		insertJob("completed-job", "w-1", 2);

		expect(await workerJobRepository.trimMany("completed", new Map())).toBe(0);
		expect(remainingIds()).toEqual(["completed-job", "failed-job"]);
	});
});

describe("workerJobRepository.cancelPending", () => {
	test("cancels a pending job and reports false for missing or non-pending rows", async () => {
		insertJob("pending-job", "w-1", 1, { status: "pending" });
		insertJob("running-job", "w-1", 2, { status: "running" });

		expect(await workerJobRepository.cancelPending("missing-job")).toBe(false);
		expect(await workerJobRepository.cancelPending("running-job")).toBe(false);
		expect(await workerJobRepository.cancelPending("pending-job")).toBe(true);
		expect(await workerJobRepository.cancelPending("pending-job")).toBe(false);

		const statuses = sqlite.query("SELECT id, status FROM worker_jobs ORDER BY id").all();
		expect(statuses).toEqual([
			{ id: "pending-job", status: "cancelled" },
			{ id: "running-job", status: "running" },
		]);
	});

	test("cascades cancellation to pending dependents", async () => {
		insertJob("parent-job", "w-1", 1, { status: "pending" });
		insertJob("child-job", "w-1", 2, { status: "pending" });
		sqlite.run("UPDATE worker_jobs SET depends_on_job_id = 'parent-job' WHERE id = 'child-job'");

		expect(await workerJobRepository.cancelPending("parent-job")).toBe(true);

		const statuses = sqlite.query("SELECT id, status FROM worker_jobs ORDER BY id").all();
		expect(statuses).toEqual([
			{ id: "child-job", status: "cancelled" },
			{ id: "parent-job", status: "cancelled" },
		]);
	});
});

describe("workerJobRepository.findActiveOperations", () => {
	test("returns only operation ids with pending or running jobs", async () => {
		insertJob("a-1", "w-1", 1, { status: "pending", operationId: "op-1" });
		insertJob("a-2", "w-1", 2, { status: "completed", operationId: "op-1" });
		insertJob("a-3", "w-1", 3, { status: "running", operationId: "op-2" });
		insertJob("a-4", "w-1", 4, { status: "failed", operationId: "op-3" });

		const active = await workerJobRepository.findActiveOperations(["op-1", "op-2", "op-3", "op-missing"]);

		expect([...active].toSorted()).toEqual(["op-1", "op-2"]);
		expect(await workerJobRepository.findActiveOperations([])).toEqual(new Set());
	});
});
