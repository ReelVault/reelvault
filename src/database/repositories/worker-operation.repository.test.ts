import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseFactory, databaseFactory } from "@/database/database";
import { workerOperationRepository } from "./worker-operation.repository";

const tempDirs: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function redirectSingleton(factory: DatabaseFactory): void {
	spies.push(
		spyOn(databaseFactory, "transaction").mockImplementation((callback, options) => factory.transaction(callback, options)),
		spyOn(databaseFactory, "getClient").mockImplementation((options) => factory.getClient(options)),
	);
}

function createFactory(): { factory: DatabaseFactory; db: DatabaseFactory["sqlite"] } {
	const tempDir = mkdtempSync(join(tmpdir(), "rv-worker-op-"));
	tempDirs.push(tempDir);
	const factory = new DatabaseFactory(join(tempDir, "test.sqlite"));
	factory.migrate();
	redirectSingleton(factory);

	return { factory, db: factory.sqlite };
}

function insertOperation(
	db: DatabaseFactory["sqlite"],
	id: string,
	status: string,
	retentionSecondsFromNow: number | null,
	nowSeconds: number,
): void {
	db.run(
		"INSERT INTO worker_operations (id, type, status, cancel_requested, total_items, pending_items, running_items, completed_items, failed_items, cancelled_items, retention_until, created_at, updated_at) VALUES (?,?,?,0,0,0,0,0,0,0,?,?,?)",
		[id, "test", status, retentionSecondsFromNow === null ? null : nowSeconds + retentionSecondsFromNow, nowSeconds, nowSeconds],
	);
}

function existingIds(db: DatabaseFactory["sqlite"]): string[] {
	return db
		.query("SELECT id FROM worker_operations ORDER BY id")
		.all()
		.map((row) => (row as { id: string }).id);
}

describe("workerOperationRepository retention", () => {
	test("expired retention never removes pending or running operations", async () => {
		const { factory, db } = createFactory();
		try {
			const now = Math.floor(Date.now() / 1000);
			insertOperation(db, "terminal-expired", "completed", -86_400, now);
			insertOperation(db, "pending-stale", "pending", -86_400, now);
			insertOperation(db, "running-stale", "running", -86_400, now);
			insertOperation(db, "terminal-fresh", "completed", 86_400, now);

			const deleted = await workerOperationRepository.cleanupExpired(new Date(now * 1000));

			expect(deleted).toBe(1);
			expect(existingIds(db)).toEqual(["pending-stale", "running-stale", "terminal-fresh"]);
		} finally {
			factory.shutdown();
		}
	});

	test("resuming an operation clears its retention deadline", async () => {
		const { factory, db } = createFactory();
		try {
			const now = Math.floor(Date.now() / 1000);
			insertOperation(db, "resumed", "cancelled", -86_400, now);

			await workerOperationRepository.markResumed("resumed");

			const row = db.query("SELECT status, retention_until AS retentionUntil FROM worker_operations WHERE id = 'resumed'").get() as {
				status: string;
				retentionUntil: number | null;
			};
			expect(row.status).toBe("pending");
			expect(row.retentionUntil).toBeNull();

			// The daily cleanup must not delete the operation that just resumed.
			expect(await workerOperationRepository.cleanupExpired(new Date(now * 1000))).toBe(0);
			expect(existingIds(db)).toEqual(["resumed"]);
		} finally {
			factory.shutdown();
		}
	});
});
