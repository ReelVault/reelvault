import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PlaybackProgressService } from "@/app/playback/playback-progress.service";
import { playbackRepository } from "@/app/repositories/playback.repository";
import { profilePreferencesRepository } from "@/app/repositories/profile-preferences.repository";
import { profileStreamPrefsRepository } from "@/app/repositories/profile-stream-prefs.repository";
import { watchedHistoryRepository } from "@/app/repositories/watched-history.repository";
import { watchlistRepository } from "@/app/repositories/watchlist.repository";
import { databaseFactory } from "@/integrations/drizzle-orm/database.factory";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { useTestDatabase } from "../helpers/test-database.helper";

const db = useTestDatabase();
const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

/** One user, profile, library and a 60-minute movie file: the rows every play refers to. */
async function seedTitle(): Promise<void> {
	const client = db.client();
	await client.insert(schema.users).values({ id: "user-1", name: "Ann", email: "ann@example.com", emailVerified: true });
	await client.insert(schema.profiles).values({ id: "profile-1", userId: "user-1", name: "Ann" });
	await client.insert(schema.libraries).values({ id: "lib-1", name: "Movies", type: "movies" });
	await client
		.insert(schema.metadata)
		.values({ id: "meta-1", stableKey: "movie-heat", title: "Heat", type: "movie", releaseDate: "1995-12-15" });
	await client.insert(schema.movies).values({ id: "movie-1", stableKey: "movie-heat", metadataId: "meta-1" });
	await client.insert(schema.mediaFiles).values({
		id: "mf-1",
		libraryId: "lib-1",
		metadataId: "meta-1",
		movieId: "movie-1",
		fileName: "heat.mkv",
		filePath: "/heat.mkv",
		size: 1_000,
		duration: 3_600,
	});
}

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
		await seedTitle();
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
