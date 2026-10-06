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
