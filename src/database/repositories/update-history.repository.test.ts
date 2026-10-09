import { afterEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { sql } from "drizzle-orm";
import { DatabaseFactory } from "@/database/database";
import { UpdateHistoryRepository } from "./update-history.repository";

const databasePaths: string[] = [];

afterEach(async () => {
	await Promise.all(databasePaths.splice(0).map(async (path) => await unlink(path).catch(() => undefined)));
});

function openHistoryDatabase(): DatabaseFactory {
	const path = `${tmpdir()}/reelvault-update-history-${process.pid}-${crypto.randomUUID()}.sqlite`;
	databasePaths.push(path, `${path}-shm`, `${path}-wal`);
	const factory = new DatabaseFactory(path);
	factory.getClient().run(
		sql.raw(`
			CREATE TABLE update_history (
				id TEXT PRIMARY KEY,
				actor_user_id TEXT,
				action TEXT NOT NULL,
				target TEXT NOT NULL,
				status TEXT NOT NULL,
				from_version TEXT,
				to_version TEXT NOT NULL,
				error_message TEXT,
				started_at INTEGER NOT NULL,
				finished_at INTEGER
			)
		`),
	);

	return factory;
}

describe("UpdateHistoryRepository", () => {
	test("opens a run as running and closes it with its outcome", async () => {
		const factory = openHistoryDatabase();
		const repository = new UpdateHistoryRepository(factory);

		const id = await repository.insert(
			{ action: "install", target: "server", fromVersion: "1.2.2", toVersion: "1.3.0", actorUserId: null },
			new Date("2026-10-09T10:00:00Z"),
		);
		expect(await repository.findRunning()).toEqual([
			expect.objectContaining({ id, status: "running", toVersion: "1.3.0", finishedAt: null }),
		]);

		await repository.finish(id, { status: "failed", errorMessage: "Checksum mismatch", finishedAt: new Date("2026-10-09T10:05:00Z") });
		expect(await repository.findRunning()).toEqual([]);

		const { data } = await repository.findPage({ limit: 10, offset: 0 });
		expect(data).toEqual([expect.objectContaining({ id, status: "failed", errorMessage: "Checksum mismatch" })]);
		factory.shutdown();
	});

	test("pages runs newest first and counts every run in the total", async () => {
		const factory = openHistoryDatabase();
		const repository = new UpdateHistoryRepository(factory);
		await repository.insert(
			{ action: "install", target: "web", fromVersion: null, toVersion: "1.0.0", actorUserId: null },
			new Date("2026-10-01T00:00:00Z"),
		);
		await repository.insert(
			{ action: "rollback", target: "web", fromVersion: "1.1.0", toVersion: "1.0.0", actorUserId: null },
			new Date("2026-10-03T00:00:00Z"),
		);
		await repository.insert(
			{ action: "install", target: "server", fromVersion: "1.2.0", toVersion: "1.3.0", actorUserId: null },
			new Date("2026-10-02T00:00:00Z"),
		);

		const firstPage = await repository.findPage({ limit: 2, offset: 0 });
		expect(firstPage.total).toBe(3);
		expect(firstPage.data.map((run) => run.startedAt.toISOString())).toEqual(["2026-10-03T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]);

		const secondPage = await repository.findPage({ limit: 2, offset: 2 });
		expect(secondPage.data.map((run) => run.startedAt.toISOString())).toEqual(["2026-10-01T00:00:00.000Z"]);
		factory.shutdown();
	});
});
