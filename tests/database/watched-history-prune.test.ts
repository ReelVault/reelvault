import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { databaseFactory } from "@/database/database";
import { watchedHistoryRepository } from "@/database/repositories/watched-history.repository";
import { schema } from "@/database/schema";

const client = databaseFactory.getClient();

beforeAll(async () => {
	await client.run(
		sql.raw(`
		CREATE TABLE IF NOT EXISTS watched_history (
			id TEXT PRIMARY KEY,
			media_file_id TEXT NOT NULL,
			profile_id TEXT NOT NULL,
			duration_watched INTEGER,
			is_full_watch INTEGER DEFAULT false NOT NULL,
			watched_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`),
	);
});

beforeEach(async () => {
	await client.delete(schema.watchedHistory);
});

const DAY_SECONDS = 86_400;

function historyRow(id: string, watchedAtSeconds: number) {
	return {
		id,
		mediaFileId: "mf-1",
		profileId: "profile-1",
		durationWatched: 600,
		isFullWatch: false,
		watchedAt: new Date(watchedAtSeconds * 1000),
		createdAt: new Date(watchedAtSeconds * 1000),
		updatedAt: new Date(watchedAtSeconds * 1000),
	};
}

describe("watchedHistoryRepository.pruneOlderThan", () => {
	test("deletes only rows watched before the cutoff", async () => {
		const now = Math.floor(Date.now() / 1000);
		await client
			.insert(schema.watchedHistory)
			.values([
				historyRow("old-1", now - 400 * DAY_SECONDS),
				historyRow("old-2", now - 200 * DAY_SECONDS),
				historyRow("fresh-1", now - 5 * DAY_SECONDS),
			]);

		const deleted = await watchedHistoryRepository.pruneOlderThan(new Date((now - 365 * DAY_SECONDS) * 1000));

		expect(deleted).toBe(1);
		const remaining = await client.select({ id: schema.watchedHistory.id }).from(schema.watchedHistory);
		expect(remaining.map((row) => row.id).toSorted()).toEqual(["fresh-1", "old-2"]);
	});

	test("returns zero for an empty table", async () => {
		const deleted = await watchedHistoryRepository.pruneOlderThan(new Date());

		expect(deleted).toBe(0);
	});
});
