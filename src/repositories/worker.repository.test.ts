import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../../tests/helpers/test-database.helper";
import { workerJobRepository } from "./worker.repository";

const { client } = useTestDatabase();

beforeEach(async () => {
	await client()
		.insert(schema.workerOperations)
		.values([
			{ id: "op-1", type: "library-scan" },
			{ id: "op-2", type: "library-scan" },
			{ id: "op-3", type: "library-scan" },
		]);
});

async function insertJob(id: string, workerId: string, completedAt: number, options: { operationId?: string; status?: string } = {}) {
	await client().run(
		sql`INSERT INTO worker_jobs (id, worker_id, status, operation_id, data, run_at, completed_at, created_at, updated_at) VALUES (${id}, ${workerId}, ${options.status ?? "completed"}, ${options.operationId ?? null}, '{}', ${completedAt}, ${completedAt}, ${completedAt}, ${completedAt})`,
	);
}

async function remainingIds(): Promise<string[]> {
	const rows = await client().all<{ id: string }>(sql`SELECT id FROM worker_jobs ORDER BY id`);

	return rows.map((row) => row.id);
}

async function statusRows(): Promise<Array<{ id: string; status: string }>> {
	return await client().all<{ id: string; status: string }>(sql`SELECT id, status FROM worker_jobs ORDER BY id`);
}

describe("workerJobRepository.trimMany", () => {
	test("keeps the newest N standalone jobs per worker", async () => {
		for (let i = 1; i <= 4; i++) await insertJob(`w1-c${i}`, "w-1", i);
		for (let i = 5; i <= 8; i++) await insertJob(`w2-c${i}`, "w-2", i);
		await insertJob("w3-c9", "w-3", 9);

		const changes = await workerJobRepository.trimMany(
			"completed",
			new Map([
				["w-1", 1],
				["w-2", 2],
				["w-3", 0],
			]),
		);

		expect(changes).toBe(6);
		expect(await remainingIds()).toEqual(["w1-c4", "w2-c7", "w2-c8"]);
	});

	test("never trims operation-grouped jobs", async () => {
		await insertJob("grouped", "w-1", 1, { operationId: "op-1" });
		await insertJob("standalone", "w-1", 2);

		await workerJobRepository.trimMany("completed", new Map([["w-1", 0]]));

		expect(await remainingIds()).toEqual(["grouped"]);
	});

	test("ignores other statuses and no-ops on an empty map", async () => {
		await insertJob("failed-job", "w-1", 1, { status: "failed" });
		await insertJob("completed-job", "w-1", 2);

		expect(await workerJobRepository.trimMany("completed", new Map())).toBe(0);
		expect(await remainingIds()).toEqual(["completed-job", "failed-job"]);
	});
});

describe("workerJobRepository.cancelPending", () => {
	test("cancels a pending job and reports false for missing or non-pending rows", async () => {
		await insertJob("pending-job", "w-1", 1, { status: "pending" });
		await insertJob("running-job", "w-1", 2, { status: "running" });

		expect(await workerJobRepository.cancelPending("missing-job")).toBe(false);
		expect(await workerJobRepository.cancelPending("running-job")).toBe(false);
		expect(await workerJobRepository.cancelPending("pending-job")).toBe(true);
		expect(await workerJobRepository.cancelPending("pending-job")).toBe(false);

		expect(await statusRows()).toEqual([
			{ id: "pending-job", status: "cancelled" },
			{ id: "running-job", status: "running" },
		]);
	});

	test("cascades cancellation to pending dependents", async () => {
		await insertJob("parent-job", "w-1", 1, { status: "pending" });
		await insertJob("child-job", "w-1", 2, { status: "pending" });
		await client().run(sql`UPDATE worker_jobs SET depends_on_job_id = 'parent-job' WHERE id = 'child-job'`);

		expect(await workerJobRepository.cancelPending("parent-job")).toBe(true);

		expect(await statusRows()).toEqual([
			{ id: "child-job", status: "cancelled" },
			{ id: "parent-job", status: "cancelled" },
		]);
	});
});

describe("workerJobRepository.findActiveOperations", () => {
	test("returns only operation ids with pending or running jobs", async () => {
		await insertJob("a-1", "w-1", 1, { status: "pending", operationId: "op-1" });
		await insertJob("a-2", "w-1", 2, { status: "completed", operationId: "op-1" });
		await insertJob("a-3", "w-1", 3, { status: "running", operationId: "op-2" });
		await insertJob("a-4", "w-1", 4, { status: "failed", operationId: "op-3" });

		const active = await workerJobRepository.findActiveOperations(["op-1", "op-2", "op-3", "op-missing"]);

		expect([...active].toSorted()).toEqual(["op-1", "op-2"]);
		expect(await workerJobRepository.findActiveOperations([])).toEqual(new Set());
	});
});

describe("workerJobRepository.countTerminalJobs", () => {
	test("counts what a purge would delete, removes nothing, and the purge then deletes exactly that many", async () => {
		await insertJob("completed-standalone", "w-1", 1);
		await insertJob("failed-standalone", "w-1", 2, { status: "failed" });
		await insertJob("grouped", "w-1", 3, { operationId: "op-1" });
		await insertJob("still-running", "w-1", 4, { status: "running" });

		expect(await workerJobRepository.countTerminalJobs({ status: "all_terminal" })).toBe(2);
		expect(await workerJobRepository.countTerminalJobs({ status: "failed" })).toBe(1);
		expect(await remainingIds()).toEqual(["completed-standalone", "failed-standalone", "grouped", "still-running"]);

		// Purging leaves operation-grouped history to the operation purge.
		expect(await workerJobRepository.purgeTerminalJobs({ status: "all_terminal" })).toBe(2);
		expect(await remainingIds()).toEqual(["grouped", "still-running"]);
	});
});
