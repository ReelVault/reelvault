import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { playbackRepository } from "@/repositories/playback.repository";
import { profilePreferencesRepository } from "@/repositories/profile-preferences.repository";
import { profileStreamPrefsRepository } from "@/repositories/profile-stream-prefs.repository";
import { watchedHistoryRepository } from "@/repositories/watched-history.repository";
import { watchlistRepository } from "@/repositories/watchlist.repository";
import { PlaybackProgressService } from "@/services/playback/playback-progress.service";
import { seedTitle } from "../helpers/media.fixture";
import { useTestDatabase } from "../helpers/test-database.helper";

const db = useTestDatabase();
const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

function createService(): PlaybackProgressService {
	return new PlaybackProgressService({
		playbackRepository,
		watchedHistoryRepository,
		profileStreamPrefsRepository,
		profilePreferencesRepository,
		watchlistRepository,
		publisher: { publishUpdate: () => undefined },
		runTransaction: (work) => databaseFactory.transaction(work),
	});
}

async function progressRows() {
	return await db.client().select().from(schema.playbackProgress);
}

async function historyRows() {
	return await db.client().select().from(schema.watchedHistory);
}

describe("completing a title writes its progress and its watched-history row together", () => {
	test("a failed history write leaves no progress behind, so the retry still records the play", async () => {
		await seedTitle(db.client(), 3_600);
		const service = createService();
		const failure = new Error("history write failed");
		spies.push(spyOn(watchedHistoryRepository, "recordPlay").mockRejectedValueOnce(failure));

		// The service wraps an unexpected error as an internal DomainError and keeps the original as its cause.
		await expect(service.updatePlaybackProgress("mf-1", { position: 3_500 }, "profile-1")).rejects.toMatchObject({
			category: "internal",
			cause: failure,
		});
		expect(await progressRows()).toEqual([]);
		expect(await historyRows()).toEqual([]);

		await service.updatePlaybackProgress("mf-1", { position: 3_500 }, "profile-1");
		expect(await progressRows()).toMatchObject([{ profileId: "profile-1", mediaFileId: "mf-1", completed: true }]);
		expect(await historyRows()).toMatchObject([{ profileId: "profile-1", mediaFileId: "mf-1", isFullWatch: true }]);

		// A third update of the finished file must not add a second play.
		await service.updatePlaybackProgress("mf-1", { position: 3_550 }, "profile-1");
		expect(await historyRows()).toHaveLength(1);
	});
});
