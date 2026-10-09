import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, databaseFactory } from "@/database/database";
import { workerJobRepository } from "./worker.repository";

const tempDirs: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A fresh migrated database per test, so the job table has its real columns.
function createFactory(): DatabaseFactory {
	const tempDir = mkdtempSync(join(tmpdir(), "rv-worker-jobs-"));
	tempDirs.push(tempDir);
	const factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
	factory.migrate();
	spies.push(
		spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)),
		spyOn(databaseFactory, "transaction").mockImplementation((callback, options) => factory.transaction(callback, options)),
	);

	return factory;
}

function insertJob(factory: DatabaseFactory, id: string, workerId: string, status: string, createdAt: number): void {
	factory.sqlite.run(
		"INSERT INTO worker_jobs (id, worker_id, status, data, run_at, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?, ?)",
		[id, workerId, status, createdAt, createdAt, createdAt],
	);
}

describe("workerJobRepository.listItems", () => {
	test("pages the newest jobs first and reports the total", async () => {
		const factory = createFactory();
		for (let i = 1; i <= 5; i++) insertJob(factory, `j${i}`, "w-1", "completed", i);

		const firstPage = await workerJobRepository.listItems({ limit: 2, offset: 0 });
		const lastPage = await workerJobRepository.listItems({ limit: 2, offset: 4 });

		expect(firstPage.items.map((item) => item.id)).toEqual(["j5", "j4"]);
		expect(lastPage.items.map((item) => item.id)).toEqual(["j1"]);
		expect(firstPage.total).toBe(5);
		expect(lastPage.total).toBe(5);
	});

	test("filters by status and by worker before counting", async () => {
		const factory = createFactory();
		insertJob(factory, "j1", "w-1", "failed", 1);
		insertJob(factory, "j2", "w-1", "completed", 2);
		insertJob(factory, "j3", "w-2", "failed", 3);

		const failed = await workerJobRepository.listItems({ limit: 10, offset: 0, status: "failed" });
		const failedOnWorkerOne = await workerJobRepository.listItems({ limit: 10, offset: 0, status: "failed", workerId: "w-1" });

		expect(failed.items.map((item) => item.id)).toEqual(["j3", "j1"]);
		expect(failed.total).toBe(2);
		expect(failedOnWorkerOne.items.map((item) => item.id)).toEqual(["j1"]);
		expect(failedOnWorkerOne.total).toBe(1);
	});
});
