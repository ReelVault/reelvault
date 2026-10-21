import { beforeEach, describe, expect, test } from "bun:test";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { watchedHistoryRepository } from "@/repositories/watched-history.repository";
import { insertMovieMediaFile } from "../helpers/media.fixture";
import { useTestDatabase } from "../helpers/test-database.helper";

const db = useTestDatabase();

const DAY_SECONDS = 86_400;

let mediaFileId: string;

beforeEach(async () => {
	const client = db.client();
	await client.insert(schema.users).values({ id: "user-1", name: "Ann", email: "ann@example.com", emailVerified: true });
	await client.insert(schema.profiles).values({ id: "profile-1", userId: "user-1", name: "Ann" });
	mediaFileId = await insertMovieMediaFile(client, "/movies/heat.mkv", "meta-heat");
});

function historyRow(id: string, watchedAtSeconds: number) {
	return {
		id,
		mediaFileId,
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
		await db
			.client()
			.insert(schema.watchedHistory)
			.values([
				historyRow("old-1", now - 400 * DAY_SECONDS),
				historyRow("old-2", now - 200 * DAY_SECONDS),
				historyRow("fresh-1", now - 5 * DAY_SECONDS),
			]);

		const deleted = await watchedHistoryRepository.pruneOlderThan(new Date((now - 365 * DAY_SECONDS) * 1000));

		expect(deleted).toBe(1);
		const remaining = await db.client().select({ id: schema.watchedHistory.id }).from(schema.watchedHistory);
		expect(remaining.map((row) => row.id).toSorted()).toEqual(["fresh-1", "old-2"]);
	});

	test("returns zero for an empty table", async () => {
		const deleted = await watchedHistoryRepository.pruneOlderThan(new Date());

		expect(deleted).toBe(0);
	});
});
