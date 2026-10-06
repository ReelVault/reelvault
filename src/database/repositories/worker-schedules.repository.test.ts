import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { databaseFactory } from "@/database/database";
import { workerSchedulesRepository } from "./worker-schedules.repository";

const sqlite = databaseFactory.sqlite;

beforeAll(() => {
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS worker_schedules (
			id TEXT PRIMARY KEY,
			worker_id TEXT NOT NULL UNIQUE,
			triggers TEXT NOT NULL,
			is_enabled INTEGER NOT NULL DEFAULT 1,
			next_run_at INTEGER,
			last_run_at INTEGER,
			last_completed_at INTEGER,
			last_status TEXT,
			last_duration_ms INTEGER,
			last_error TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
});

beforeEach(() => {
	sqlite.run("DELETE FROM worker_schedules");
});

function nextRunAtSeconds(): Record<string, number | null> {
	const rows = sqlite.query("SELECT worker_id, next_run_at FROM worker_schedules ORDER BY worker_id").all();
	return Object.fromEntries(
		rows.map((row) => {
			const record = row as Record<string, unknown>;

			return [String(record.worker_id), record.next_run_at === null ? null : Number(record.next_run_at)];
		}),
	);
}

describe("workerSchedulesRepository.setNextRunAtMany", () => {
	test("upserts armed deadlines and clears only existing rows for null deadlines", async () => {
		await workerSchedulesRepository.setNextRunAt("w-1", new Date("2026-01-01T00:00:00Z"));

		const first = new Date("2026-02-01T00:00:00Z");
		const second = new Date("2026-03-01T00:00:00Z");
		await workerSchedulesRepository.setNextRunAtMany([
			{ workerId: "w-1", nextRunAt: first },
			{ workerId: "w-2", nextRunAt: second },
			{ workerId: "w-3", nextRunAt: null },
		]);

		expect(nextRunAtSeconds()).toEqual({
			"w-1": Math.floor(first.getTime() / 1000),
			"w-2": Math.floor(second.getTime() / 1000),
		});
	});

	test("is a no-op for an empty list", async () => {
		await workerSchedulesRepository.setNextRunAtMany([]);

		expect(nextRunAtSeconds()).toEqual({});
	});
});
