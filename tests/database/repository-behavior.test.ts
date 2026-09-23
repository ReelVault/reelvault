import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { userRatingsRepository } from "@/database/repositories/user-ratings.repository";
import { watchlistRepository } from "@/database/repositories/watchlist.repository";
import { workerSchedulesRepository } from "@/database/repositories/worker-schedules.repository";
import { schema } from "@/database/schema";

const client = databaseFactory.getClient();

beforeAll(async () => {
	await client.run(
		sql.raw(`
			CREATE TABLE IF NOT EXISTS user_ratings (
				id TEXT PRIMARY KEY NOT NULL,
				profile_id TEXT NOT NULL,
				metadata_id TEXT NOT NULL,
				rating INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`),
	);
	await client.run(sql.raw("CREATE UNIQUE INDEX IF NOT EXISTS user_ratings_unique ON user_ratings (profile_id, metadata_id)"));
	await client.run(
		sql.raw(`
			CREATE TABLE IF NOT EXISTS watchlist (
				id TEXT PRIMARY KEY NOT NULL,
				profile_id TEXT NOT NULL,
				metadata_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`),
	);
	await client.run(sql.raw("CREATE UNIQUE INDEX IF NOT EXISTS watchlist_unique ON watchlist (profile_id, metadata_id)"));
	await client.run(
		sql.raw(`
			CREATE TABLE IF NOT EXISTS worker_schedules (
				id TEXT PRIMARY KEY NOT NULL,
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
		`),
	);
});

beforeEach(async () => {
	await client.delete(schema.userRatings);
	await client.delete(schema.watchlist);
	await client.delete(schema.workerSchedules);
});

describe("repository write behavior", () => {
	test("updates an existing user rating", async () => {
		await userRatingsRepository.upsert({ profileId: "profile", metadataId: "metadata", rating: 3 });
		const updated = await userRatingsRepository.upsert({ profileId: "profile", metadataId: "metadata", rating: 9 });

		expect(updated?.rating).toBe(9);
		expect(await userRatingsRepository.count()).toBe(1);
	});

	test("toggles a watchlist row using atomic writes", async () => {
		expect(await watchlistRepository.toggle({ profileId: "profile", metadataId: "metadata" })).toEqual({ added: true });
		expect(await watchlistRepository.toggle({ profileId: "profile", metadataId: "metadata" })).toEqual({ added: false });
		expect(await watchlistRepository.count()).toBe(0);
	});

	test("handles nested and concurrent transactions without savepoint errors", async () => {
		const task1 = databaseFactory.transaction(async () => {
			await userRatingsRepository.upsert({ profileId: "p1", metadataId: "m1", rating: 5 });

			// Nested transaction
			await databaseFactory.transaction(async () => {
				await userRatingsRepository.upsert({ profileId: "p1", metadataId: "m2", rating: 8 });
			});
		});

		const task2 = databaseFactory.transaction(async () => {
			await userRatingsRepository.upsert({ profileId: "p2", metadataId: "m1", rating: 10 });
		});

		await Promise.all([task1, task2]);
		expect(await userRatingsRepository.count()).toBe(3);
	});

	test("upserts a worker schedule row on first write and updates it on the next", async () => {
		const completedAt = new Date();
		await workerSchedulesRepository.updateExecution("image-processing", {
			status: "completed",
			startedAt: new Date(completedAt.getTime() - 100),
			completedAt,
			durationMs: 100,
		});

		const inserted = await workerSchedulesRepository.getSchedule("image-processing");
		expect(inserted?.lastStatus).toBe("completed");
		expect(inserted?.lastDurationMs).toBe(100);
		expect(inserted?.lastError).toBeNull();
		expect(inserted?.isEnabled).toBe(true);
		expect(inserted?.triggers).toEqual([]);
		// timestamp columns store whole seconds — sub-second precision is dropped
		expect(inserted?.lastCompletedAt?.getTime()).toBe(Math.floor(completedAt.getTime() / 1000) * 1000);

		const failedAt = new Date();
		await workerSchedulesRepository.updateExecution("image-processing", {
			status: "failed",
			completedAt: failedAt,
			durationMs: 250,
			error: "boom",
		});

		const updated = await workerSchedulesRepository.getSchedule("image-processing");
		expect(updated?.lastStatus).toBe("failed");
		expect(updated?.lastDurationMs).toBe(250);
		expect(updated?.lastError).toBe("boom");
		expect(await workerSchedulesRepository.getConfiguredWorkerIds()).toEqual(["image-processing"]);
	});

	test("setTriggers inserts once and replaces triggers on repeat writes", async () => {
		await workerSchedulesRepository.setTriggers("metadata-refresh", [{ id: "t1", type: "interval", intervalMinutes: 60 }]);
		await workerSchedulesRepository.setTriggers("metadata-refresh", [{ id: "t2", type: "daily", timeOfDay: "03:00" }]);

		const row = await workerSchedulesRepository.getSchedule("metadata-refresh");
		expect(row?.triggers).toEqual([{ id: "t2", type: "daily", timeOfDay: "03:00" }]);

		const allTriggers = await workerSchedulesRepository.getAllTriggers();
		expect(allTriggers.get("metadata-refresh")).toEqual([{ id: "t2", type: "daily", timeOfDay: "03:00" }]);
	});

	test("TableAccess generic returning and batch methods work correctly", async () => {
		// insertReturning
		const [row1, row2] = await watchlistRepository.insertReturning({
			values: [
				{ profileId: "p1", metadataId: "m1" },
				{ profileId: "p1", metadataId: "m2" },
			],
		});
		expect(row1).toBeDefined();
		expect(row2).toBeDefined();
		if (!(row1 && row2)) throw new Error("Expected inserted rows");

		expect(row1.profileId).toBe("p1");
		expect(row1.metadataId).toBe("m1");
		expect(row2.metadataId).toBe("m2");

		// findByIds
		const foundByIds = await watchlistRepository.findByIds({ ids: [row1.id, row2.id] });
		expect(foundByIds).toHaveLength(2);

		// findByColumnIn
		const foundByCol = await watchlistRepository.findByColumnIn(watchlistRepository.table.metadataId, ["m1", "m2"]);
		expect(foundByCol).toHaveLength(2);

		// updateReturning
		const [updatedRow] = await watchlistRepository.updateReturning({
			primaryId: row1.id,
			values: { metadataId: "m1-updated" },
		});
		expect(updatedRow?.metadataId).toBe("m1-updated");

		// updateAndReturn
		const updatedAndRead = await watchlistRepository.updateAndReturn({
			primaryId: row1.id,
			values: { metadataId: "m1-v2" },
		});
		expect(updatedAndRead?.metadataId).toBe("m1-v2");

		// deleteAndReturn
		const deletedSingle = await watchlistRepository.deleteAndReturn({ primaryId: row1.id });
		expect(deletedSingle?.id).toBe(row1.id);

		// deleteReturning
		const deletedBatch = await watchlistRepository.deleteReturning({ ids: [row2.id] });
		expect(deletedBatch).toHaveLength(1);
		expect(deletedBatch[0]?.id).toBe(row2.id);

		// empty guards
		expect(await watchlistRepository.findByIds({ ids: [] })).toEqual([]);
		expect(await watchlistRepository.findByColumnIn(watchlistRepository.table.metadataId, [])).toEqual([]);
	});
});
