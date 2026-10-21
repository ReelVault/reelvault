import { describe, expect, test } from "bun:test";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { userRatingsRepository } from "@/repositories/user-ratings.repository";
import { watchlistRepository } from "@/repositories/watchlist.repository";
import { workerSchedulesRepository } from "@/repositories/worker-schedules.repository";
import { useTestDatabase } from "../helpers/test-database.helper";

const db = useTestDatabase();

/** Seeds one user and profile per id, and one metadata row per id: the rows the junction tables point at. */
async function seedProfilesAndMetadata(profileIds: string[], metadataIds: string[]): Promise<void> {
	const client = db.client();
	for (const id of profileIds) {
		await client.insert(schema.users).values({ id: `user-${id}`, name: id, email: `${id}@example.com`, emailVerified: true });
		await client.insert(schema.profiles).values({ id, userId: `user-${id}`, name: id });
	}
	for (const id of metadataIds) {
		await client.insert(schema.metadata).values({ id, stableKey: id, title: id, type: "movie", releaseDate: "2020-01-01" });
	}
}

describe("repository write behavior", () => {
	test("updates an existing user rating", async () => {
		await seedProfilesAndMetadata(["profile"], ["metadata"]);
		await userRatingsRepository.upsert({ profileId: "profile", metadataId: "metadata", rating: 1 });
		const updated = await userRatingsRepository.upsert({ profileId: "profile", metadataId: "metadata", rating: 2 });

		expect(updated?.rating).toBe(2);
		expect(await userRatingsRepository.count()).toBe(1);
	});

	test("toggles a watchlist row using atomic writes", async () => {
		await seedProfilesAndMetadata(["profile"], ["metadata"]);

		expect(await watchlistRepository.toggle({ profileId: "profile", metadataId: "metadata" })).toEqual({ added: true });
		expect(await watchlistRepository.toggle({ profileId: "profile", metadataId: "metadata" })).toEqual({ added: false });
		expect(await watchlistRepository.count()).toBe(0);
	});

	test("nested and concurrent transactions complete without savepoint errors", async () => {
		await seedProfilesAndMetadata(["p1", "p2"], ["m1", "m2"]);
		const task1 = databaseFactory.transaction(async () => {
			await userRatingsRepository.upsert({ profileId: "p1", metadataId: "m1", rating: 1 });

			// Nested transaction
			await databaseFactory.transaction(async () => {
				await userRatingsRepository.upsert({ profileId: "p1", metadataId: "m2", rating: 2 });
			});
		});

		const task2 = databaseFactory.transaction(async () => {
			await userRatingsRepository.upsert({ profileId: "p2", metadataId: "m1", rating: 2 });
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
});

describe("TableAccess batch and returning methods", () => {
	test("insertReturning hands back both rows, and the batch reads find them", async () => {
		await seedProfilesAndMetadata(["p1"], ["m1", "m2"]);
		const [row1, row2] = await watchlistRepository.insertReturning({
			values: [
				{ profileId: "p1", metadataId: "m1" },
				{ profileId: "p1", metadataId: "m2" },
			],
		});
		if (!(row1 && row2)) throw new Error("Expected inserted rows");

		expect([row1.profileId, row1.metadataId, row2.metadataId]).toEqual(["p1", "m1", "m2"]);
		expect(await watchlistRepository.findByIds({ ids: [row1.id, row2.id] })).toHaveLength(2);
		expect(await watchlistRepository.findByColumnIn(watchlistRepository.table.metadataId, ["m1", "m2"])).toHaveLength(2);
	});

	test("update and delete variants return the affected rows", async () => {
		await seedProfilesAndMetadata(["p1"], ["m1", "m2", "m3", "m4"]);
		const [row1, row2] = await watchlistRepository.insertReturning({
			values: [
				{ profileId: "p1", metadataId: "m1" },
				{ profileId: "p1", metadataId: "m2" },
			],
		});
		if (!(row1 && row2)) throw new Error("Expected inserted rows");

		const [updatedRow] = await watchlistRepository.updateReturning({ primaryId: row1.id, values: { metadataId: "m3" } });
		expect(updatedRow?.metadataId).toBe("m3");

		const updatedAndRead = await watchlistRepository.updateAndReturn({ primaryId: row1.id, values: { metadataId: "m4" } });
		expect(updatedAndRead?.metadataId).toBe("m4");

		expect((await watchlistRepository.deleteAndReturn({ primaryId: row1.id }))?.id).toBe(row1.id);
		const deletedBatch = await watchlistRepository.deleteReturning({ ids: [row2.id] });
		expect(deletedBatch.map((row) => row.id)).toEqual([row2.id]);
	});

	test("batch reads given no ids return no rows", async () => {
		expect(await watchlistRepository.findByIds({ ids: [] })).toEqual([]);
		expect(await watchlistRepository.findByColumnIn(watchlistRepository.table.metadataId, [])).toEqual([]);
	});
});
